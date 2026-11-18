import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {captureScreens, planCaptures, type DesignCaptureDriver, type DesignCapturePlan} from '../src/design-capture.ts';
import {runDesignModule} from '../src/design-module.ts';
import {parseDesignProjectConfig, planDesignRoutes, type DesignStateReach, type PlannedRoute} from '../src/design-project-config.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE = 'http://127.0.0.1:4173';

function routeHash(route: string): string {
  return createHash('sha256').update(route).digest('hex').slice(0, 8);
}

function isConfigRefusal(error: unknown): boolean {
  return error instanceof Refusal && error.code === 'DESIGN_CONFIG_INVALID';
}

function driver(urls: string[], themes: Array<'claro' | 'escuro'>): DesignCaptureDriver {
  return {
    async setViewport() {},
    async emulateMedia(theme) {
      themes.push(theme);
    },
    async goto(url) {
      urls.push(url);
    },
    async screenshot() {
      return PNG;
    },
    async content() {
      return '<main>texto escuro</main>';
    },
    async fill() {},
    async click() {},
  };
}

test('tema escuro navega sem consulta estado=', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-states-'));
  try {
    const urls: string[] = [];
    const themes: Array<'claro' | 'escuro'> = [];
    const plans = planCaptures([{id: 'home', route: '/home', hasDarkTheme: true, forceStates: true}]);
    const meta = await captureScreens(driver(urls, themes), BASE, plans, join(parent, 'saida'));
    assert.ok(themes.includes('escuro'));
    assert.ok(urls.length > 0);
    assert.ok(urls.every(url => url === `${BASE}/home` && !url.includes('estado=')));
    assert.ok(meta.captures.every(item => item.state === 'padrao' && !item.url.includes('estado=')));
    assert.equal(meta.emptyStates[0]?.status, 'nao-capturado');
    assert.ok(meta.skipped?.some(item => item.state === 'vazio' && item.reason === 'sem-alcance'));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('estado com url navega para essa url', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-states-'));
  try {
    const config = parseDesignProjectConfig(JSON.stringify({
      routes: {'/lista': {states: {vazio: {url: '/estado/vazio'}}, dark: false}},
    }));
    const planned = planDesignRoutes({discovered: [{route: '/lista'}], dynamicSkipped: [], config, darkInSource: false});
    const reach = planned.planned[0]?.states.find(item => item.name === 'vazio');
    assert.deepEqual(reach, {name: 'vazio', url: '/estado/vazio'});
    const urls: string[] = [];
    const plan: DesignCapturePlan = {
      screenId: 'lista',
      route: '/lista',
      viewport: 375,
      theme: 'claro',
      state: 'vazio',
      fileName: 'lista-vazio.png',
      reach: {kind: 'url', path: reach && 'url' in reach ? reach.url : ''},
    };
    const meta = await captureScreens(driver(urls, []), BASE, [plan], join(parent, 'saida'));
    assert.deepEqual(urls, [`${BASE}/estado/vazio`]);
    assert.equal(urls.some(url => url.includes('estado=')), false);
    assert.equal(meta.captures[0]?.url, `${BASE}/estado/vazio`);
    assert.equal(meta.emptyStates[0]?.status, 'capturado');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('estado so com nome na lista antiga nao navega', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-states-'));
  try {
    const config = parseDesignProjectConfig(JSON.stringify({
      routes: {'/': {states: ['vazio', 'logado'], dark: false}},
    }));
    const planned = planDesignRoutes({
      discovered: [{route: '/'}, {route: '/painel'}],
      dynamicSkipped: ['/item/:id'],
      config,
      darkInSource: false,
    });
    assert.deepEqual(planned.planned[0]?.states, [{name: 'padrao'}]);
    assert.equal(planned.planned[0]?.loginState, true);
    assert.equal(planned.planned[1]?.loginState, false);
    assert.equal(planned.wantsLogin, true);
    assert.deepEqual(planned.notes, [
      'Rota /item/:id pulada: sem exemplo em design.config.json.',
      '/: estado vazio e logado não capturado.',
      '/painel: estado vazio, carregando, erro e logado não capturado.',
    ]);
    const urls: string[] = [];
    const plans: DesignCapturePlan[] = planned.planned
      .filter(route => route.route === '/')
      .flatMap(route => route.states.map(state => toCapture(route, state)));
    const meta = await captureScreens(driver(urls, []), BASE, plans, join(parent, 'saida'));
    assert.deepEqual(urls, [`${BASE}/`]);
    assert.ok(urls.every(url => !url.includes('estado=')));
    assert.equal(meta.captures.every(item => item.state === 'padrao'), true);
    const named = await captureScreens(driver(urls, []), BASE, [{
      screenId: 'lista',
      route: '/lista',
      viewport: 375,
      theme: 'claro',
      state: 'vazio',
      fileName: 'lista-vazio.png',
    }], join(parent, 'nome'));
    assert.equal(urls.filter(url => url.includes('/lista')).length, 0);
    assert.equal(named.captures.length, 0);
    assert.equal(named.skipped?.[0]?.reason, 'sem-alcance');
    assert.equal(named.emptyStates[0]?.status, 'nao-capturado');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('rotas /a-b e /a/b geram nomes diferentes', () => {
  const plans = planCaptures([
    {id: '/a-b', route: '/a-b', hasDarkTheme: false, forceStates: false},
    {id: '/a/b', route: '/a/b', hasDarkTheme: false, forceStates: false},
  ]);
  const left = plans[0]?.fileName;
  const right = plans[3]?.fileName;
  assert.equal(left, `a-b-${routeHash('/a-b')}-375-claro-padrao.png`);
  assert.equal(right, `a-b-${routeHash('/a/b')}-375-claro-padrao.png`);
  assert.notEqual(left, right);
  assert.equal(routeHash('/a-b').length, 8);
  assert.ok(plans.every(plan => /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(plan.fileName)));
});

test('config com acoes invalida recusa', () => {
  assert.throws(
    () => parseDesignProjectConfig(JSON.stringify({
      routes: {'/': {states: {erro: {acoes: ['clicar', 'esperar #mensagem']}}}},
    })),
    isConfigRefusal,
  );
  assert.throws(
    () => parseDesignProjectConfig(JSON.stringify({
      routes: {'/': {states: {vazio: {url: 'javascript:alert(1)'}}}},
    })),
    isConfigRefusal,
  );
  assert.throws(
    () => parseDesignProjectConfig(JSON.stringify({
      routes: {'/': {states: {vazio: {url: '/../segredo'}}}},
    })),
    isConfigRefusal,
  );
  assert.throws(() => parseDesignProjectConfig('{'), isConfigRefusal);
  const bare = parseDesignProjectConfig(JSON.stringify({routes: {'/': {states: ['vazio', 'logado']}}}));
  assert.deepEqual(bare.routes['/']?.bareStates, ['vazio', 'logado']);
  assert.deepEqual(bare.routes['/']?.reaches, []);
});

test('config com url valida planeja o estado', () => {
  const config = parseDesignProjectConfig(JSON.stringify({
    routes: {
      '/lista': {
        dark: true,
        states: {
          vazio: {url: '/estado/vazio'},
          erro: {acoes: ['clicar button.erro', 'esperar #mensagem']},
          logado: {url: '/conta'},
        },
      },
      '/item/:id': {example: '/item/42', states: {erro: {url: '/item/42/erro'}}, dark: false},
    },
  }));
  const planned = planDesignRoutes({
    discovered: [{route: '/lista'}],
    dynamicSkipped: ['/item/:id'],
    config,
    darkInSource: false,
  });
  assert.equal(planned.wantsLogin, false);
  assert.equal(planned.planned[0]?.loginState, false);
  assert.deepEqual(planned.planned[0]?.themes, ['claro', 'escuro']);
  assert.deepEqual(planned.planned[0]?.states, [
    {name: 'padrao'},
    {name: 'vazio', url: '/estado/vazio'},
    {name: 'erro', acoes: ['clicar button.erro', 'esperar #mensagem']},
    {name: 'logado', url: '/conta'},
  ] satisfies DesignStateReach[]);
  assert.equal(planned.notes.some(note => note.startsWith('/lista: estado')), false);
  assert.equal(planned.notes.some(note => note === 'A rota /item/:id usou o exemplo /item/42.'), true);
  assert.deepEqual(planned.planned[1]?.states, [
    {name: 'padrao'},
    {name: 'erro', url: '/item/42/erro'},
  ]);
  const host = parseDesignProjectConfig(JSON.stringify({
    routes: {'/': {states: {logado: {}, vazio: {url: '/estado/vazio'}}}},
  }));
  const login = planDesignRoutes({discovered: [{route: '/'}], dynamicSkipped: [], config: host, darkInSource: false});
  assert.equal(login.wantsLogin, true);
  assert.equal(login.planned[0]?.loginState, true);
  assert.deepEqual(login.planned[0]?.states, [{name: 'padrao'}, {name: 'vazio', url: '/estado/vazio'}]);
  assert.equal(login.notes.some(note => note === '/: estado logado não capturado.'), true);
});

function toCapture(route: PlannedRoute, state: DesignStateReach): DesignCapturePlan {
  const fileName = `tela-${route.route === '/' ? 'raiz' : 'rota'}-${state.name}.png`;
  if (state.name === 'padrao') {
    return {screenId: 'tela', route: route.route, viewport: 375, theme: 'claro', state: 'padrao', fileName};
  }
  if ('url' in state) {
    return {
      screenId: 'tela',
      route: route.route,
      viewport: 375,
      theme: 'claro',
      state: state.name,
      fileName,
      reach: {kind: 'url', path: state.url},
    };
  }
  return {
    screenId: 'tela',
    route: route.route,
    viewport: 375,
    theme: 'claro',
    state: state.name,
    fileName,
    reach: {kind: 'acoes', steps: state.acoes},
  };
}

test('recusa urls e seletores de estado com palavras de efeito colateral', () => {
  const forbidden = ['logout', 'Sair', 'DELETE', 'Excluir', 'rEmOvEr', 'apagar'];
  for (const word of forbidden) {
    assert.throws(
      () => parseDesignProjectConfig(JSON.stringify({
        routes: {'/': {states: {logado: {url: `/conta/${word}`}}}},
      })),
      isConfigRefusal,
      `URL com ${word} deveria ser recusada`,
    );
    for (const action of [
      `clicar button.${word}`,
      `esperar #modal-${word}`,
      `preencher input[name="${word}"] valor`,
    ]) {
      assert.throws(
        () => parseDesignProjectConfig(JSON.stringify({
          routes: {'/': {states: {erro: {acoes: [action]}}}},
        })),
        isConfigRefusal,
        `Ação "${action}" deveria ser recusada`,
      );
    }
  }
  assert.throws(
    () => parseDesignProjectConfig(JSON.stringify({
      routes: {'/': {states: {logado: {url: '/%73air'}}}},
    })),
    isConfigRefusal,
  );
  const allowed = parseDesignProjectConfig(JSON.stringify({
    routes: {
      '/': {
        states: {
          vazio: {url: '/estado/vazio'},
          erro: {acoes: ['clicar button.erro', 'esperar #mensagem', 'preencher #busca filtro']},
        },
      },
    },
  }));
  assert.equal(allowed.routes['/']?.reaches.length, 2);
});

test('relatorio informa que design.config.json vem do repositorio do proprio titular', async () => {
  const data = await mkdtemp(join(tmpdir(), 'ac-design-config-note-'));
  const repo = await mkdtemp(join(tmpdir(), 'ac-design-config-repo-'));
  const bench = designBenchWorker();
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:30:00.000Z'),
      commit: 'abc123',
      files: [
        {path: 'index.html', text: '<html><body><h1>Inicio</h1></body></html>'},
        {
          path: 'design.config.json',
          text: JSON.stringify({
            routes: {
              '/': {
                states: {
                  vazio: {url: '/estado/vazio'},
                  carregando: {url: '/estado/carregando'},
                  erro: {acoes: ['clicar button.erro']},
                  logado: {url: '/conta'},
                },
              },
            },
          }),
        },
      ],
      worker: {async run(call) { return bench.run(call); }},
      reserve: async role => ({provider: 'claude', model: role, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
      release: async () => {},
      recordStates: true,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /repositório do próprio titular/);
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});
