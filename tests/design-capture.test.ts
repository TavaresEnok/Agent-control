import assert from 'node:assert/strict';
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
  | {op: 'click'; selector: string};

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
    {screenId: 'home', route: '/home', viewport: 375, theme: 'claro', state: 'padrao', fileName: 'home-375-claro-padrao.png'},
    {screenId: 'home', route: '/home', viewport: 768, theme: 'claro', state: 'padrao', fileName: 'home-768-claro-padrao.png'},
    {screenId: 'home', route: '/home', viewport: 1440, theme: 'claro', state: 'padrao', fileName: 'home-1440-claro-padrao.png'},
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
  assert.equal(messy[0]?.fileName, 'a-b-c-375-claro-padrao.png');
  const duplicated = planCaptures([
    {id: 'home', route: '/a', hasDarkTheme: false, forceStates: false},
    {id: 'home', route: '/b', hasDarkTheme: false, forceStates: false},
  ]);
  assert.equal(duplicated[3]?.fileName, 'home-2-375-claro-padrao.png');
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
    assert.equal(urls.filter(url => url.includes('/completa') && url.includes('estado=vazio')).length, 6);
    assert.equal(urls.filter(url => url.includes('/completa') && url.includes('estado=carregando')).length, 6);
    assert.equal(urls.filter(url => url.includes('/completa') && url.includes('estado=erro')).length, 6);
    assert.ok(urls.filter(url => url.startsWith(`${BASE}/simples`)).every(url => !url.includes('estado=')));
    assert.equal(driver.calls.filter(call => call.op === 'theme' && call.theme === 'escuro').length, 12);
    assert.equal(driver.calls.filter(call => call.op === 'shot').length, plans.length);
    const names = await readdir(dir);
    assert.equal(names.length, plans.length + 1);
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

test('estado forcado acrescenta a consulta sem apagar rota nem fragmento', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ac-design-capture-'));
  try {
    const driver = fakeDriver();
    const plans: DesignCapturePlan[] = [
      {screenId: 'itens', route: '/itens?aba=1#topo', viewport: 375, theme: 'claro', state: 'erro', fileName: 'itens-375-claro-erro.png'},
      {screenId: 'itens', route: '/itens', viewport: 768, theme: 'escuro', state: 'padrao', fileName: 'itens-768-escuro-padrao.png'},
    ];
    await captureScreens(driver, `${BASE}/`, plans, join(parent, 'saida'));
    const urls = driver.calls.filter(call => call.op === 'goto').map(call => call.url);
    assert.deepEqual(urls, [
      `${BASE}/itens?aba=1&estado=erro#topo`,
      `${BASE}/itens`,
    ]);
    assert.ok(driver.calls.some(call => call.op === 'theme' && call.theme === 'escuro'));
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
