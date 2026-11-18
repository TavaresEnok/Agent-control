import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseCreateBundle, runDesignCreate, sanitizeCss, sanitizeGeneratedHtml} from '../src/design-create.ts';
import {Refusal} from '../src/contracts.ts';
import type {DesignRawFinding, DesignWorker} from '../src/design-types.ts';

const vectors: {name: string; html: string; absent: string[]; present: string[]}[] = [
  {
    name: 'script',
    html: '<script>alert(1)</script><p>seguro</p>',
    absent: ['<script', 'alert(1)'],
    present: ['seguro'],
  },
  {
    name: 'onerror',
    html: '<img onerror=alert(1) alt="foto"><p>seguro</p>',
    absent: ['onerror', 'alert(1)'],
    present: ['seguro', 'foto'],
  },
  {
    name: 'iframe',
    html: '<iframe src=https://evil></iframe><p>seguro</p>',
    absent: ['<iframe', 'https://evil'],
    present: ['seguro'],
  },
  {
    name: 'object',
    html: '<object data="https://evil/a.swf">payload-object</object><p>seguro</p>',
    absent: ['<object', 'payload-object', 'https://evil'],
    present: ['seguro'],
  },
  {
    name: 'embed',
    html: '<embed src="https://evil/a.swf"><p>seguro</p>',
    absent: ['<embed', 'https://evil'],
    present: ['seguro'],
  },
  {
    name: 'meta refresh',
    html: '<meta http-equiv="refresh" content="0;url=https://evil"><p>seguro</p>',
    absent: ['http-equiv', 'https://evil'],
    present: ['seguro'],
  },
  {
    name: 'base',
    html: '<base href="https://evil/"><p>seguro</p>',
    absent: ['<base', 'https://evil'],
    present: ['seguro'],
  },
  {
    name: 'javascript',
    html: '<a href="javascript:alert(1)">texto</a>',
    absent: ['javascript:', 'alert(1)'],
    present: ['texto'],
  },
  {
    name: 'img https',
    html: '<img src="https://evil/a.png" alt="foto">',
    absent: ['https://evil/a.png'],
    present: ['foto'],
  },
  {
    name: 'img protocol-relative',
    html: '<img src="//evil/a.png" alt="foto">',
    absent: ['//evil/a.png'],
    present: ['foto'],
  },
  {
    name: 'srcset',
    html: '<img srcset="https://evil/a.png 800w, //evil/b.png 2x, foto-local.png 400w" alt="foto">',
    absent: ['https://evil/a.png', '//evil/b.png'],
    present: ['foto-local.png', 'foto'],
  },
  {
    name: '@import',
    html: '<style>@import "https://evil/x.css"; h1{color:#123}</style>',
    absent: ['https://evil/x.css'],
    present: ['#123'],
  },
  {
    name: 'style url',
    html: '<p style="color:#111;background:url(https://evil/a.png)">texto</p>',
    absent: ['https://evil/a.png'],
    present: ['texto', '#111'],
  },
  {
    name: 'fontes google',
    html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    absent: [],
    present: ['href="https://fonts.googleapis.com/css2?family=Inter"', 'rel="stylesheet"'],
  },
];

for (const vector of vectors) {
  test(`sanitize: ${vector.name}`, () => {
    const out = sanitizeGeneratedHtml(vector.html);
    for (const piece of vector.absent) assert.equal(out.includes(piece), false, `${vector.name} ainda tem ${piece}\n${out}`);
    for (const piece of vector.present) assert.equal(out.includes(piece), true, `${vector.name} perdeu ${piece}\n${out}`);
  });
}

test('link de fonte gstatic fica e outro host sai', () => {
  const out = sanitizeGeneratedHtml('<link rel="stylesheet" href="https://fonts.gstatic.com/s/inter.woff2"><link rel="stylesheet" href="https://evil.example/a.css">');
  assert.equal(out.includes('https://fonts.gstatic.com/s/inter.woff2'), true);
  assert.equal(out.includes('evil.example'), false);
});

test('exceção de fonte não vale para img', () => {
  const out = sanitizeGeneratedHtml('<img src="https://fonts.googleapis.com/a.png" alt="nao">');
  assert.equal(out.includes('fonts.googleapis.com'), false);
  assert.equal(out.includes('nao'), true);
});

test('css e imagem locais permanecem', () => {
  const out = sanitizeGeneratedHtml('<link rel="stylesheet" href="inicio.css"><img src="hero.jpg" alt="local">');
  assert.match(out, /href="inicio\.css"/);
  assert.match(out, /src="hero\.jpg"/);
});

test('script dentro de template sai', () => {
  const out = sanitizeGeneratedHtml('<template><script>alert(1)</script><p>dentro</p></template>');
  assert.equal(out.includes('alert(1)'), false);
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('dentro'), true);
});

test('javascript com tab e maiúsculas sai', () => {
  const out = sanitizeGeneratedHtml('<a href="java&#9;script:alert(1)">x</a><a href="JAVASCRIPT:alert(1)">y</a>');
  assert.equal(out.toLowerCase().includes('javascript'), false);
  assert.equal(out.includes('alert(1)'), false);
  assert.equal(out.includes('>x<'), true);
  assert.equal(out.includes('>y<'), true);
});

test('url css com escape hexadecimal sai', () => {
  const out = sanitizeGeneratedHtml('<div style="background:url(\\68 ttps://evil/a.png)">z</div>');
  assert.equal(out.includes('evil'), false);
  assert.equal(out.includes('>z<'), true);
});

test('css da tela perde import e url externos e guarda o resto', () => {
  const bundle = parseCreateBundle({
    tokens: {color: {fundo: {$type: 'color', $value: '#fff'}}},
    screens: [{
      name: 'inicio',
      html: '<p>ok</p>',
      css: '@import "https://evil/x.css"; @import "tema.css"; body{color:#111;background:url(//evil/a.png);background-image:url(hero.jpg)}',
    }],
  }, 1);
  assert.ok(bundle);
  const css = bundle.screens[0]?.css ?? '';
  assert.equal(css.includes('https://evil'), false);
  assert.equal(css.includes('//evil'), false);
  assert.match(css, /@import "tema\.css"/);
  assert.match(css, /hero\.jpg/);
  assert.match(css, /#111/);
});

test('noscript é removido por inteiro', () => {
  const out = sanitizeGeneratedHtml('<head><noscript><link rel="stylesheet" href="https://evil/a.css"></noscript></head><body><noscript><img src="https://evil/p.png"><p>sem-js</p></noscript><template><noscript>dentro-template</noscript></template><p>visivel</p></body>');
  assert.equal(out.toLowerCase().includes('noscript'), false);
  assert.equal(out.includes('evil'), false);
  assert.equal(out.includes('sem-js'), false);
  assert.equal(out.includes('dentro-template'), false);
  assert.equal(out.includes('visivel'), true);
});

test('esquemas ftp, ws, file, blob e data fora de png/jpeg/webp são removidos em HTML e CSS', () => {
  const html = [
    '<a href="ftp://evil/arquivo">ftp-link</a>',
    '<a href="ws://evil/socket">ws-link</a>',
    '<a href="wss://evil/socket">wss-link</a>',
    '<img src="file:///etc/passwd" alt="file-img">',
    '<img src="blob:https://evil/123" alt="blob-img">',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="svg-img">',
    '<img src="data:text/html,<script>alert(1)</script>" alt="html-img">',
    '<img src="data:image/gif;base64,R0lGODlh" alt="gif-img">',
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="png-ok">',
    '<img src="data:image/jpeg;base64,/9j/4AAQ" alt="jpg-ok">',
    '<img src="data:image/webp;base64,UklGRh4=" alt="webp-ok">',
    '<img src="/\\evil/attr.png" alt="backslash-img">',
    '<img srcset="ftp://evil/a.png 1x, data:image/svg+xml,<svg> 2x, data:image/png;base64,AAAA 2x, ./local.png 1x" alt="srcset-ok">',
    '<div style="background:url(ftp://evil/a.png);list-style-image:url(ws://evil/b.png);mask-image:url(file:///a.png);content:url(blob:https://evil/1);border-image:url(data:image/svg+xml,<svg>);outline:1px solid #111">st</div>',
    '<style>',
    '@import "ftp://evil/x.css";',
    '@import "data:text/css,body{color:red}";',
    '.a{background:url(ftp://evil/a.png)}',
    '.b{background:url(ws://evil/b.png)}',
    '.c{background:url(file:///c.png)}',
    '.d{background:url(blob:https://evil/d)}',
    '.e{background:url(data:text/html,<script>)}',
    '.f{background:url(data:image/svg+xml;base64,PHN2Zz4=)}',
    '.g{background:url(data:image/png;base64,iVBORw0KGgo=)}',
    '.h{background:url(data:image/jpeg;base64,/9j/4AAQ)}',
    '.i{background:url(data:image/webp;base64,UklGRh4=)}',
    '.j{background:url(/\\\\evil/j.png);mask:url(//evil/k.png)}',
    '</style>',
  ].join('');
  const out = sanitizeGeneratedHtml(html);
  for (const blocked of ['ftp:', 'ws:', 'wss:', 'file:', 'blob:', 'svg+xml', 'text/html', 'image/gif', 'text/css', '//evil', '/\\evil']) {
    assert.equal(out.toLowerCase().includes(blocked), false, `vazou ${blocked} em:\n${out}`);
  }
  for (const kept of [
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQ',
    'data:image/webp;base64,UklGRh4=',
    'data:image/png;base64,AAAA 2x, ./local.png 1x',
    'outline:1px solid #111',
  ]) {
    assert.equal(out.includes(kept), true, `perdeu ${kept} em:\n${out}`);
  }
});

test('image-set e -webkit-image-set aceitam só relativo ou data:image/{png,jpeg,webp}', () => {
  const html = [
    '<div style="background-image:image-set(\'https://evil/a.png\' 1x, \'ftp://evil/b.png\' 2x, \'./local.png\' 2x, \'data:image/webp;base64,UklGRh4=\' type(\'image/webp\'))">ok1</div>',
    '<div style="background-image:-webkit-image-set(url(ws://evil/a.png) 1x, \'data:image/svg+xml,<svg>\' 2x)">ok2</div>',
    '<style>',
    '.x{background-image:\\69 mage-set("https://evil/x.png" 1x, "blob:https://evil/y" 2x, "../hero.jpg" 1x)}',
    '.y{background-image:-webkit-image-set("https://fonts.gstatic.com/a.png" 1x, "data:image/png;base64,AAAA" 2x)}',
    '.z{background-image:image-set(url(file:///etc/passwd) 1x)}',
    '</style>',
  ].join('');
  const out = sanitizeGeneratedHtml(html);
  for (const blocked of ['https://evil', 'ftp://', 'ws://', 'svg+xml', 'blob:', 'fonts.gstatic.com', 'file://']) {
    assert.equal(out.includes(blocked), false, `vazou ${blocked} em:\n${out}`);
  }
  assert.equal(out.includes("'./local.png' 2x"), true);
  assert.equal(out.includes('data:image/webp;base64,UklGRh4='), true);
  assert.equal(out.includes('"../hero.jpg" 1x'), true);
  assert.equal(out.includes('data:image/png;base64,AAAA'), true);
  assert.match(out, /ok2[\s\S]*background-image:none/);
});

test('fonts.googleapis.com e fonts.gstatic.com só passam em @import e @font-face', () => {
  const css = [
    '@import "https://fonts.googleapis.com/css2?family=Inter";',
    '@import url("https://fonts.gstatic.com/s/inter.css");',
    '@import "https://evil.example/x.css";',
    '@import "https://fonts.googleapis.com@evil.example/x.css";',
    '@import "tema.css";',
    '@font-face{font-family:"Inter";src:url("https://fonts.gstatic.com/s/inter.woff2") format("woff2"),url("https://evil.example/f.woff2")}',
    '@font-face{font-family:"G";src:url("https://fonts.googleapis.com/css?family=G")}',
    'body{background:url("https://fonts.gstatic.com/leak.png");color:url("https://fonts.googleapis.com/leak2.png");mask:url("./ok.png")}',
  ].join('\n');
  const out = sanitizeCss(css);
  assert.equal(out.includes('https://fonts.googleapis.com/css2?family=Inter'), true);
  assert.equal(out.includes('https://fonts.gstatic.com/s/inter.css'), true);
  assert.equal(out.includes('@import "tema.css";'), true);
  assert.equal(out.includes('https://fonts.gstatic.com/s/inter.woff2'), true);
  assert.equal(out.includes('https://fonts.googleapis.com/css?family=G'), true);
  assert.equal(out.includes('./ok.png'), true);
  assert.equal(out.includes('evil.example'), false);
  assert.equal(out.includes('leak.png'), false);
  assert.equal(out.includes('leak2.png'), false);

  const inlineStyle = sanitizeGeneratedHtml('<div style="@import \'https://fonts.googleapis.com/css2\';background:url(\'https://fonts.gstatic.com/a.png\');color:#111">x</div>');
  assert.equal(inlineStyle.includes('fonts.googleapis.com'), false);
  assert.equal(inlineStyle.includes('fonts.gstatic.com'), false);
  assert.equal(inlineStyle.includes('#111'), true);
});

function seat() {
  return {provider: 'claude', model: 'claude-opus-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
}

async function withDirs(run: (paths: {data: string; repo: string}) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'design-create-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-repo-'));
  try {
    await run({data, repo});
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
}

test('html sem </head> grava o link da tela', async () => {
  await withDirs(async ({data, repo}) => {
    const worker: DesignWorker = {
      async run() {
        return JSON.stringify({
          kind: 'criacao',
          tokens: {color: {fundo: {$type: 'color', $value: '#fff'}}},
          screens: [
            {name: 'inicio', html: '<html><body><h1>Sem cabeca</h1></body></html>', css: 'body{margin:0;color:#111}'},
            {name: 'detalhe', html: '<html><head><meta charset="utf-8"></head><body><h1>Com cabeca</h1></body></html>', css: 'body{margin:0;color:#222}'},
          ],
        });
      },
    };
    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: 'Duas telas.',
      screens: 2,
      rounds: 1,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async () => ({
        notes: [],
        screens: [
          {name: 'inicio', rejected: false, findings: [], visualNotes: []},
          {name: 'detalhe', rejected: false, findings: [], visualNotes: []},
        ],
      }),
    });
    const inicio = await readFile(join(created.directory, 'rodada-1', 'inicio.html'), 'utf8');
    const detalhe = await readFile(join(created.directory, 'rodada-1', 'detalhe.html'), 'utf8');
    assert.match(inicio, /<head>[\s\S]*<link rel="stylesheet" href="inicio\.css">[\s\S]*<\/head>[\s\S]*<body/);
    assert.match(inicio, /Sem cabeca/);
    assert.match(detalhe, /<link rel="stylesheet" href="detalhe\.css">/);
    assert.match(detalhe, /charset="utf-8"/);
    assert.match(detalhe, /Com cabeca/);
  });
});

function finding(snippet: string, measure?: DesignRawFinding['measure']): DesignRawFinding {
  const row: DesignRawFinding = {
    tool: 'visual',
    rule: 'DESIGN-VISUAL-MARCA',
    cwe: null,
    file: 'detalhe.css',
    line: 1,
    severity: 'media',
    snippet,
    fingerprint: snippet.startsWith('com') ? 'b'.repeat(64) : 'c'.repeat(64),
  };
  if (measure) row.measure = measure;
  return row;
}

test('retrabalho pede só a tela rejeitada e regrava a aprovada', async () => {
  await withDirs(async ({data, repo}) => {
    let reworkTask = '';
    const worker: DesignWorker = {
      async run(call) {
        if (call.task.includes('HTML anterior:')) {
          reworkTask = call.task;
          return JSON.stringify({
            kind: 'criacao',
            tokens: {rodada: 2},
            screens: [
              {name: 'inicio', html: '<html><body><h1>Inicio adulterado</h1></body></html>', css: 'body{color:#999}'},
              {name: 'detalhe', html: '<html><body><h1>Detalhe novo</h1></body></html>', css: 'body{color:#333}'},
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {rodada: 1},
          screens: [
            {name: 'inicio', html: '<html><head></head><body><h1>Inicio estavel</h1></body></html>', css: 'body{color:#111}'},
            {name: 'detalhe', html: '<html><body><h1>Detalhe ruim</h1></body></html>', css: 'body{color:#222}'},
          ],
        });
      },
    };
    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: 'Corrigir o detalhe.',
      screens: 2,
      rounds: 3,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => ({
        notes: [round === 1 ? 'nota <1>' : 'nota 2'],
        screens: files.filter(file => file.path.endsWith('.html')).map(file => {
          const name = file.path.slice(0, -'.html'.length);
          const rejected = file.text.includes('Detalhe ruim');
          return {
            name,
            rejected,
            findings: rejected ? [finding('sem-medida'), finding('com-medida', {kind: 'contrast', ratio: 2.2})] : [],
            visualNotes: rejected ? ['afastar <b>titulo</b>'] : name === 'detalhe' ? ['respirou'] : [],
          };
        }),
      }),
    });
    assert.equal(created.rounds.length, 2);
    assert.deepEqual(created.rounds[0]?.rejected, ['detalhe']);
    assert.deepEqual(created.rounds[0]?.approved, ['inicio']);
    assert.deepEqual(created.rounds[1]?.approved, ['inicio', 'detalhe']);
    assert.equal(created.rounds[1]?.rejected.length, 0);
    const round1Inicio = await readFile(join(created.directory, 'rodada-1', 'inicio.html'), 'utf8');
    const round2Inicio = await readFile(join(created.directory, 'rodada-2', 'inicio.html'), 'utf8');
    const round2InicioCss = await readFile(join(created.directory, 'rodada-2', 'inicio.css'), 'utf8');
    const round2Detalhe = await readFile(join(created.directory, 'rodada-2', 'detalhe.html'), 'utf8');
    const round2DetalheCss = await readFile(join(created.directory, 'rodada-2', 'detalhe.css'), 'utf8');
    assert.equal(round2Inicio, round1Inicio);
    assert.equal(round2Inicio.includes('Inicio adulterado'), false);
    assert.match(round2Inicio, /Inicio estavel/);
    assert.match(round2InicioCss, /#111/);
    assert.equal(round2InicioCss.includes('#999'), false);
    assert.match(round2Detalhe, /Detalhe novo/);
    assert.match(round2DetalheCss, /#333/);
    assert.match(reworkTask, /screens tem 1 itens/);
    assert.match(reworkTask, /Tela rejeitada detalhe/);
    assert.equal(reworkTask.includes('Tela rejeitada inicio'), false);
    assert.equal(reworkTask.includes('Inicio estavel'), false);
    assert.match(reworkTask, /Detalhe ruim/);
    assert.match(reworkTask, /Achados para corrigir/);
    assert.match(reworkTask, /com-medida/);
    assert.equal(reworkTask.includes('sem-medida'), false);
    assert.match(reworkTask, /afastar <b>titulo<\/b>/);
    const index = await readFile(created.indexPath, 'utf8');
    assert.match(index, /Rodada 1/);
    assert.match(index, /Rodada 2/);
    assert.match(index, /rodada-1\/inicio\.html/);
    assert.match(index, /rodada-2\/inicio\.html/);
    assert.match(index, /rodada-1\/detalhe\.html/);
    assert.match(index, /rodada-2\/detalhe\.html/);
    assert.match(index, /nota &lt;1&gt;/);
    assert.match(index, /nota 2/);
    assert.match(index, /afastar &lt;b&gt;titulo&lt;\/b&gt;/);
    assert.match(index, /respirou/);
    assert.equal(index.includes('<b>'), false);
  });
});

test('modelo que omite a tela rejeitada invalida a rodada', async () => {
  await withDirs(async ({data, repo}) => {
    const worker: DesignWorker = {
      async run(call) {
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {rodada: 2},
            screens: [{name: 'inicio', html: '<html><body><h1>Inicio</h1></body></html>', css: 'body{color:#111}'}],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {rodada: 1},
          screens: [
            {name: 'inicio', html: '<html><body><h1>Inicio</h1></body></html>', css: 'body{color:#111}'},
            {name: 'detalhe', html: '<html><body><h1>Detalhe ruim</h1></body></html>', css: 'body{color:#222}'},
          ],
        });
      },
    };
    await assert.rejects(
      () => runDesignCreate({
        dataDirectory: data,
        runId: randomUUID(),
        repository: repo,
        briefing: 'Falta a tela.',
        screens: 2,
        rounds: 2,
        referenceNote: '',
        worker,
        reserve: async () => seat(),
        release: async () => {},
        intentId: randomUUID(),
        examine: async (_round, files) => ({
          notes: [],
          screens: files.filter(file => file.path.endsWith('.html')).map(file => ({
            name: file.path.slice(0, -'.html'.length),
            rejected: file.text.includes('Detalhe ruim'),
            findings: [],
            visualNotes: [],
          })),
        }),
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
  });
});

test('html anterior no retrabalho corta em 8000 caracteres', async () => {
  await withDirs(async ({data, repo}) => {
    let reworkTask = '';
    const long = `<html><body><p>${'b'.repeat(12000)}</p><i>FIMUNICO</i></body></html>`;
    const worker: DesignWorker = {
      async run(call) {
        if (call.task.includes('HTML anterior:')) {
          reworkTask = call.task;
          return JSON.stringify({
            kind: 'criacao',
            tokens: {rodada: 2},
            screens: [{name: 'inicio', html: '<html><body><h1>Curto</h1></body></html>', css: 'body{color:#111}'}],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {rodada: 1},
          screens: [{name: 'inicio', html: long, css: 'body{color:#111}'}],
        });
      },
    };
    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: 'Texto longo.',
      screens: 1,
      rounds: 2,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => ({
        notes: [`nota ${round}`],
        screens: [{
          name: 'inicio',
          rejected: files.some(file => file.text.includes('FIMUNICO')),
          findings: [{
            tool: 'visual',
            rule: 'DESIGN-ALVO',
            cwe: null,
            file: 'inicio.html',
            line: 1,
            severity: 'alta',
            snippet: 'largo',
            fingerprint: 'd'.repeat(64),
            measure: {kind: 'target', px: 12},
          }],
          visualNotes: ['corta'],
        }],
      }),
    });
    const written = await readFile(join(created.directory, 'rodada-1', 'inicio.html'), 'utf8');
    assert.ok(written.length > 8000);
    assert.equal(reworkTask.includes(written.slice(0, 8000)), true);
    assert.equal(reworkTask.includes('FIMUNICO'), false);
    assert.match(reworkTask, /corta/);
    const index = await readFile(created.indexPath, 'utf8');
    assert.match(index, /Rodada 1/);
    assert.match(index, /Rodada 2/);
    assert.match(index, /nota 1/);
    assert.match(index, /nota 2/);
  });
});
