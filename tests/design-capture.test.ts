import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  DESIGN_CAPTURE_METADATA_FILE,
  captureScreens,
  planCaptures,
  type DesignCaptureDriver,
  type DesignCapturePlan,
} from '../src/design-capture.ts';
import type {DesignLogin} from '../src/design-discover.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SECRET = 'correta-senha-9f3';
const BASE = 'http://127.0.0.1:4173';

const login: DesignLogin = {
  username: 'ada',
  password: SECRET,
  usernameSelector: '#usuario',
  passwordSelector: '#senha',
  submitSelector: 'button[type=submit]',
};

type Call =
  | {op: 'viewport'; width: number; height: number}
  | {op: 'theme'; theme: 'claro' | 'escuro'}
  | {op: 'goto'; url: string}
  | {op: 'shot'; fullPage: true}
  | {op: 'content'}
  | {op: 'fill'; selector: string; value: string}
  | {op: 'click'; selector: string}
  | {op: 'wait'; selector: string};

function routeHash(route: string): string {
  return createHash('sha256').update(route).digest('hex').slice(0, 8);
}

function pngName(id: string, route: string, viewport: number, theme: string, state: string): string {
  return `${id}-${routeHash(route)}-${viewport}-${theme}-${state}.png`;
}

function fakeDriver(): DesignCaptureDriver & {calls: Call[]} {
  const calls: Call[] = [];
  return {
    calls,
    async setViewport(width: number, height: number) {
      calls.push({op: 'viewport', width, height});
    },
    async emulateMedia(theme: 'claro' | 'escuro') {
      calls.push({op: 'theme', theme});
    },
    async goto(url: string) {
      calls.push({op: 'goto', url});
    },
    async screenshot(fullPage: true) {
      calls.push({op: 'shot', fullPage});
      return PNG;
    },
    async content() {
      calls.push({op: 'content'});
      return '<main></main>';
    },
    async fill(selector: string, value: string) {
      calls.push({op: 'fill', selector, value});
    },
    async click(selector: string) {
      calls.push({op: 'click', selector});
    },
  };
}

function isRefusal(error: unknown, code: string): boolean {
  return error instanceof Refusal && error.code === code;
}

test('plano sempre tem tres larguras; escuro e estados so quando pedidos', () => {
  const plain = planCaptures([{id: 'home', route: '/home', hasDarkTheme: false, forceStates: false}]);
  assert.deepEqual(plain, [
    {screenId: 'home', route: '/home', viewport: 375, theme: 'claro', state: 'padrao', fileName: pngName('home', '/home', 375, 'claro', 'padrao')},
    {screenId: 'home', route: '/home', viewport: 768, theme: 'claro', state: 'padrao', fileName: pngName('home', '/home', 768, 'claro', 'padrao')},
    {screenId: 'home', route: '/home', viewport: 1440, theme: 'claro', state: 'padrao', fileName: pngName('home', '/home', 1440, 'claro', 'padrao')},
  ]);
  const dark = planCaptures([{id: 'home', route: '/home', hasDarkTheme: true, forceStates: false}]);
  assert.equal(dark.length, 6);
  assert.equal(dark.filter(plan => plan.theme === 'escuro').length, 3);
  assert.ok(dark.every(plan => plan.state === 'padrao'));
  const forced = planCaptures([{id: 'home', route: '/home', hasDarkTheme: false, forceStates: true}]);
  assert.equal(forced.length, 12);
  assert.deepEqual([...new Set(forced.map(plan => plan.state))], ['padrao', 'vazio', 'carregando', 'erro']);
  assert.ok(forced.every(plan => plan.theme === 'claro'));
  const both = planCaptures([{id: 'home', route: '/home', hasDarkTheme: true, forceStates: true}]);
  assert.equal(both.length, 24);
  assert.equal(both.filter(plan => plan.theme === 'escuro').length, 12);
  assert.ok(both.some(plan => plan.theme === 'escuro' && plan.state === 'vazio'));
  assert.ok(both.every(plan => /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(plan.fileName) && !plan.fileName.includes('..')));
  const messy = planCaptures([{id: 'a/b c', route: '/x', hasDarkTheme: false, forceStates: false}]);
  assert.equal(messy[0]?.fileName, pngName('a-b-c', '/x', 375, 'claro', 'padrao'));
  const duplicated = planCaptures([
    {id: 'home', route: '/a', hasDarkTheme: false, forceStates: false},
    {id: 'home', route: '/a', hasDarkTheme: false, forceStates: false},
  ]);
  assert.equal(duplicated[3]?.fileName, `home-2-${routeHash('/a')}-375-claro-padrao.png`);
  const distinct = planCaptures([
    {id: '/a-b', route: '/a-b', hasDarkTheme: false, forceStates: false},
    {id: '/a/b', route: '/a/b', hasDarkTheme: false, forceStates: false},
  ]);
  assert.equal(distinct[0]?.fileName, pngName('a-b', '/a-b', 375, 'claro', 'padrao'));
  assert.equal(distinct[3]?.fileName, pngName('a-b', '/a/b', 375, 'claro', 'padrao'));
  assert.notEqual(distinct[0]?.fileName, distinct[3]?.fileName);
});

test('captura tres larguras sem tema escuro e sem estado forcado', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const driver = fakeDriver();
    const plans = planCaptures([{id: 'simples', route: '/simples', hasDarkTheme: false, forceStates: false}]);
    const dir = join(parent, 'saida');
    const meta = await captureScreens(driver, BASE, plans, dir);
    assert.deepEqual(driver.calls.filter(call => call.op === 'viewport'), [
      {op: 'viewport', width: 375, height: 812},
      {op: 'viewport', width: 768, height: 1024},
      {op: 'viewport', width: 1440, height: 900},
    ]);
    assert.ok(driver.calls.every(call => call.op !== 'theme' || call.theme === 'claro'));
    const urls = driver.calls.filter(call => call.op === 'goto').map(call => call.url);
    assert.deepEqual(urls, [`${BASE}/simples`, `${BASE}/simples`, `${BASE}/simples`]);
    assert.ok(urls.every(url => !url.includes('estado=')));
    assert.equal(driver.calls.filter(call => call.op === 'shot' && call.fullPage === true).length, 3);
    assert.equal(meta.captures.length, 3);
    assert.equal(meta.login, undefined);
    for (const plan of plans) {
      const bytes = await readFile(join(dir, plan.fileName));
      assert.deepEqual(bytes, PNG);
    }
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('captura tema escuro, estados forcados e login sem gravar a senha', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const driver = fakeDriver();
    const plans = planCaptures([
      {id: 'simples', route: '/simples', hasDarkTheme: false, forceStates: false},
      {id: 'completa', route: '/completa', hasDarkTheme: true, forceStates: true},
    ]);
    const dir = join(parent, 'saida');
    const meta = await captureScreens(driver, BASE, plans, dir, {login});
    assert.deepEqual(driver.calls.slice(0, 4), [
      {op: 'goto', url: BASE},
      {op: 'fill', selector: '#usuario', value: 'ada'},
      {op: 'fill', selector: '#senha', value: SECRET},
      {op: 'click', selector: 'button[type=submit]'},
    ]);
    const urls = driver.calls.filter(call => call.op === 'goto').map(call => call.url).slice(1);
    assert.equal(urls.filter(url => url === `${BASE}/simples`).length, 3);
    assert.equal(urls.filter(url => url === `${BASE}/completa`).length, 6);
    assert.ok(urls.every(url => !url.includes('estado=')));
    assert.ok(meta.captures.every(item => item.state === 'padrao'));
    assert.equal(meta.emptyStates.find(item => item.screenId === 'completa')?.status, 'nao-capturado');
    assert.ok(meta.skipped?.some(item => item.route === '/completa' && item.state === 'vazio' && item.reason === 'sem-alcance'));
    assert.equal(driver.calls.filter(call => call.op === 'theme' && call.theme === 'escuro').length, 3);
    assert.equal(driver.calls.filter(call => call.op === 'shot').length, meta.captures.length);
    const names = await readdir(dir);
    assert.equal(names.length, meta.captures.length + 1);
    assert.ok(names.includes(DESIGN_CAPTURE_METADATA_FILE));
    for (const name of names) {
      const bytes = await readFile(join(dir, name));
      assert.equal(bytes.includes(Buffer.from(SECRET)), false);
      const info = await stat(join(dir, name));
      assert.equal(info.mode & 0o777, 0o600);
    }
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const raw = await readFile(join(dir, DESIGN_CAPTURE_METADATA_FILE), 'utf8');
    const parsed = JSON.parse(raw) as {captures: unknown[]; login?: Record<string, string>};
    assert.deepEqual(parsed, meta);
    assert.equal(parsed.login?.username, 'ada');
    assert.equal(parsed.login !== undefined && Object.hasOwn(parsed.login, 'password'), false);
    assert.equal(raw.includes(SECRET), false);
    assert.equal(JSON.stringify(meta).includes(SECRET), false);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('estado sem alcance nao navega e url declarada nao inventa estado=', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const driver = fakeDriver();
    const plans: DesignCapturePlan[] = [
      {screenId: 'itens', route: '/itens?aba=1#topo', viewport: 375, theme: 'claro', state: 'padrao', fileName: 'itens-375-claro-padrao.png'},
      {screenId: 'itens', route: '/itens', viewport: 768, theme: 'claro', state: 'erro', fileName: 'itens-768-claro-erro.png'},
      {
        screenId: 'itens',
        route: '/itens',
        viewport: 375,
        theme: 'escuro',
        state: 'vazio',
        fileName: 'itens-375-escuro-vazio.png',
        reach: {kind: 'url', path: '/estado/vazio'},
      },
    ];
    const meta = await captureScreens(driver, `${BASE}/`, plans, join(parent, 'saida'));
    const urls = driver.calls.filter(call => call.op === 'goto').map(call => call.url);
    assert.deepEqual(urls, [
      `${BASE}/itens?aba=1#topo`,
      `${BASE}/estado/vazio`,
    ]);
    assert.ok(urls.every(url => !url.includes('estado=')));
    assert.equal(meta.skipped?.some(item => item.state === 'erro' && item.reason === 'sem-alcance'), true);
    assert.equal(meta.captures.some(item => item.state === 'vazio' && item.url === `${BASE}/estado/vazio`), true);
    assert.equal(meta.emptyStates.find(item => item.route === '/itens')?.status, 'capturado');
    assert.ok(driver.calls.some(call => call.op === 'theme' && call.theme === 'escuro'));
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('rota com estado vazio sem alcance fica nao capturado', async () => {
  const plain = planCaptures([{id: 'home', route: '/home', hasDarkTheme: false, forceStates: false}]);
  assert.equal(plain.length, 3);
  assert.ok(plain.every(plan => plan.state === 'padrao'));
  const empty = planCaptures([{id: 'home', route: '/home', hasDarkTheme: false, forceStates: false, hasEmptyState: true}]);
  assert.equal(empty.length, 6);
  assert.deepEqual(empty.map(plan => plan.state), ['padrao', 'padrao', 'padrao', 'vazio', 'vazio', 'vazio']);
  assert.equal(planCaptures([{id: 'home', route: '/home', hasDarkTheme: true, forceStates: true, hasEmptyState: true}]).length, 24);
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const urls: string[] = [];
    const driver: DesignCaptureDriver = {
      async setViewport() {},
      async emulateMedia() {},
      async goto(next) {
        urls.push(next);
      },
      async screenshot() {
        return PNG;
      },
      async content() {
        return '<main></main>';
      },
    };
    const plans = planCaptures([
      {id: 'lista', route: '/lista', hasDarkTheme: false, forceStates: false, hasEmptyState: true},
      {id: 'home', route: '/home', hasDarkTheme: false, forceStates: false},
      {id: 'skip', route: '/skip', hasDarkTheme: false, forceStates: false, hasEmptyState: true},
    ]);
    const meta = await captureScreens(driver, BASE, plans, join(parent, 'saida'));
    assert.ok(urls.every(url => !url.includes('estado=')));
    assert.equal(meta.captures.some(item => item.state === 'vazio'), false);
    assert.equal(meta.skipped?.filter(item => item.state === 'vazio' && item.reason === 'sem-alcance').length, 6);
    assert.deepEqual(meta.emptyStates, [
      {screenId: 'lista', route: '/lista', status: 'nao-capturado'},
      {screenId: 'home', route: '/home', status: 'ausente'},
      {screenId: 'skip', route: '/skip', status: 'nao-capturado'},
    ]);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('acoes do alcance rodam no driver e esperar sem waitForSelector nao captura', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const calls: Call[] = [];
    const driver: DesignCaptureDriver & {calls: Call[]} = {
      calls,
      async setViewport(width, height) {
        calls.push({op: 'viewport', width, height});
      },
      async emulateMedia(theme) {
        calls.push({op: 'theme', theme});
      },
      async goto(url) {
        calls.push({op: 'goto', url});
      },
      async screenshot(fullPage) {
        calls.push({op: 'shot', fullPage});
        return PNG;
      },
      async content() {
        calls.push({op: 'content'});
        return '<main></main>';
      },
      async fill(selector, value) {
        calls.push({op: 'fill', selector, value});
      },
      async click(selector) {
        calls.push({op: 'click', selector});
      },
      async waitForSelector(selector) {
        calls.push({op: 'wait', selector});
      },
    };
    const acted = await captureScreens(driver, BASE, [{
      screenId: 'erro',
      route: '/lista',
      viewport: 375,
      theme: 'claro',
      state: 'erro',
      fileName: 'erro-375-claro-erro.png',
      reach: {kind: 'acoes', steps: ['clicar button.erro', 'preencher #campo sem dados', 'esperar #mensagem']},
    }], join(parent, 'com-espera'));
    assert.deepEqual(calls.map(call => call.op), ['viewport', 'theme', 'goto', 'click', 'fill', 'wait', 'content', 'shot']);
    assert.equal(calls.some(call => call.op === 'goto' && call.url === `${BASE}/lista` && !call.url.includes('estado=')), true);
    assert.equal(calls.some(call => call.op === 'click' && call.selector === 'button.erro'), true);
    assert.equal(calls.some(call => call.op === 'fill' && call.selector === '#campo' && call.value === 'sem dados'), true);
    assert.equal(calls.some(call => call.op === 'wait' && call.selector === '#mensagem'), true);
    assert.equal(acted.captures.length, 1);
    const bare = fakeDriver();
    const skipped = await captureScreens(bare, BASE, [{
      screenId: 'erro',
      route: '/lista',
      viewport: 768,
      theme: 'escuro',
      state: 'erro',
      fileName: 'erro-768-escuro-erro.png',
      reach: {kind: 'acoes', steps: ['clicar button.erro', 'esperar #mensagem']},
    }], join(parent, 'sem-espera'));
    assert.equal(bare.calls.some(call => call.op === 'goto' || call.op === 'shot' || call.op === 'click'), false);
    assert.equal(skipped.captures.length, 0);
    assert.equal(skipped.skipped?.[0]?.reason, 'sem-espera');
    assert.equal(skipped.skipped?.[0]?.state, 'erro');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('resposta JSON ou texto nao vira captura de tela', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const calls: Call[] = [];
    const bodies = ['{"error":"AUTH_REQUIRED"}', 'not-a-page', '<main>ok</main>'];
    const driver: DesignCaptureDriver = {
      async setViewport(width, height) {
        calls.push({op: 'viewport', width, height});
      },
      async emulateMedia(theme) {
        calls.push({op: 'theme', theme});
      },
      async goto(url) {
        calls.push({op: 'goto', url});
      },
      async screenshot(fullPage) {
        calls.push({op: 'shot', fullPage});
        return PNG;
      },
      async content() {
        calls.push({op: 'content'});
        return bodies.shift() ?? '';
      },
    };
    const plans: DesignCapturePlan[] = [
      {screenId: 'tarefa', route: '/tasks/1', viewport: 375, theme: 'claro', state: 'padrao', fileName: 'tarefa-375-claro-padrao.png'},
      {screenId: 'texto', route: '/texto', viewport: 768, theme: 'claro', state: 'padrao', fileName: 'texto-768-claro-padrao.png'},
      {screenId: 'html', route: '/html', viewport: 1440, theme: 'claro', state: 'padrao', fileName: 'html-1440-claro-padrao.png'},
    ];
    const dir = join(parent, 'saida');
    const meta = await captureScreens(driver, BASE, plans, dir);
    assert.equal(calls.filter(call => call.op === 'shot').length, 1);
    assert.deepEqual(meta.captures.map(item => item.fileName), ['html-1440-claro-padrao.png']);
    assert.equal(meta.skipped?.length, 2);
    assert.equal(meta.skipped?.[0]?.route, '/tasks/1');
    assert.equal(meta.skipped?.[1]?.route, '/texto');
    assert.equal(meta.login, undefined);
    const names = await readdir(dir);
    assert.deepEqual(names.sort(), [DESIGN_CAPTURE_METADATA_FILE, 'html-1440-claro-padrao.png']);
    const raw = await readFile(join(dir, DESIGN_CAPTURE_METADATA_FILE), 'utf8');
    assert.deepEqual(JSON.parse(raw), meta);
    assert.equal(raw.includes('AUTH_REQUIRED'), true);
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('JSON embrulhado pelo navegador nao vira captura e uma pagina com texto continua', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const bodies = [
      '<html><body><pre>{"error":"AUTH_REQUIRED"}</pre></body></html>',
      '<main><h1>Documentação</h1><pre>{"ok":true}</pre></main>',
    ];
    const shots: string[] = [];
    const driver: DesignCaptureDriver = {
      async setViewport() {},
      async emulateMedia() {},
      async goto() {},
      async screenshot() {
        shots.push('shot');
        return PNG;
      },
      async content() {
        return bodies.shift() ?? '';
      },
    };
    const meta = await captureScreens(driver, BASE, [
      {screenId: 'json', route: '/equipe', viewport: 375, theme: 'claro', state: 'padrao', fileName: 'json-375-claro-padrao.png'},
      {screenId: 'docs', route: '/docs', viewport: 768, theme: 'claro', state: 'padrao', fileName: 'docs-768-claro-padrao.png'},
    ], join(parent, 'saida'));
    assert.deepEqual(shots, ['shot']);
    assert.deepEqual(meta.captures.map(item => item.route), ['/docs']);
    assert.equal(meta.skipped?.[0]?.route, '/equipe');
    assert.equal(meta.skipped?.[0]?.reason, 'nao-e-html');
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('recusa senha no metadado, nome inseguro e driver sem preenchimento', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const leaked = join(parent, 'vazou');
    await assert.rejects(
      () => captureScreens(fakeDriver(), BASE, [{
        screenId: 'x',
        route: `/${SECRET}`,
        viewport: 375,
        theme: 'claro',
        state: 'padrao',
        fileName: 'x-375-claro-padrao.png',
      }], leaked, {login}),
      (error: unknown) => isRefusal(error, 'DESIGN_PASSWORD_LEAK'),
    );
    await assert.rejects(() => stat(leaked), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    const outside = join(parent, 'fora');
    await assert.rejects(
      () => captureScreens(fakeDriver(), BASE, [{
        screenId: 'x',
        route: '/x',
        viewport: 375,
        theme: 'claro',
        state: 'padrao',
        fileName: '../x.png',
      }], outside),
      (error: unknown) => isRefusal(error, 'DESIGN_PATH_FORBIDDEN'),
    );
    await assert.rejects(() => stat(outside));
    const bare: DesignCaptureDriver = {
      async setViewport() {},
      async emulateMedia() {},
      async goto() {},
      async screenshot() { return PNG; },
      async content() { return ''; },
    };
    await assert.rejects(
      () => captureScreens(bare, BASE, [], join(parent, 'sem-metodo'), {login}),
      (error: unknown) => error instanceof Error && error.message === 'DRIVER_LOGIN_INCOMPLETO',
    );
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('a captura com sessão valida cada rota e abandona os PNGs se voltar ao login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-capture-auth-'));
  try {
    const driver = fakeDriver();
    const checked: string[] = [];
    const plans = ['/painel', '/expirada'].map((route, index): DesignCapturePlan => ({
      screenId: String(index), route, viewport: 375, theme: 'claro', state: 'padrao',
      fileName: `tela-${index}.png`,
    }));
    const withSession: DesignCaptureDriver = {
      ...driver,
      async verifyAuthenticated(url) {
        checked.push(new URL(url).pathname);
        if (url.endsWith('/expirada')) throw new Refusal('DESIGN_CAPTURE_LOGIN_FAILED');
      },
    };
    await assert.rejects(
      captureScreens(withSession, BASE, plans, directory, {login, loginUrl: BASE + '/acesso'}),
      error => isRefusal(error, 'DESIGN_CAPTURE_LOGIN_FAILED'),
    );
    assert.deepEqual(checked, ['/painel', '/painel', '/expirada', '/expirada']);
    assert.equal(driver.calls[0]?.op === 'goto' && driver.calls[0].url, BASE + '/acesso');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
