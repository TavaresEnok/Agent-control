import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {assertInternalDesignNetwork} from '../src/design-trust.ts';
import {claimDesignContainer, closeDesignContainers, releaseDesignContainer, resetDesignContainersForTest, setDesignContainerRemoverForTest} from '../src/design-containers.ts';
// @ts-expect-error módulo da imagem, em JavaScript puro
import {bodyLeaksPassword, cookieChanged, cookieMap, loginOpened, pageShowsLogin, publicRoute, samePage} from '../deploy/design-tools/login-decision.mjs';
import {existsSync} from 'node:fs';

const base = {hiddenReads: 0, left: false, changed: false, secondStep: false, successRequired: false, successVisible: false};

test('login real: abre com campo oculto em leituras seguidas, cookie novo e saída da página', () => {
  assert.equal(loginOpened({...base, hiddenReads: 2, left: true, changed: true}), true);
  assert.equal(loginOpened({...base, hiddenReads: 1, left: true, changed: true}), false, 'uma leitura só não basta');
  assert.equal(loginOpened({...base, hiddenReads: 3, left: true, changed: false}), false, 'sem cookie nem storage novo');
});

test('SPA na mesma URL precisa do campo oculto por mais tempo', () => {
  assert.equal(loginOpened({...base, hiddenReads: 2, changed: true}), false);
  assert.equal(loginOpened({...base, hiddenReads: 4, changed: true}), true);
});

test('segundo fator na tela nunca conta como sessão aberta', () => {
  assert.equal(loginOpened({...base, hiddenReads: 5, left: true, changed: true, secondStep: true}), false);
  assert.equal(loginOpened({...base, successRequired: true, successVisible: true, secondStep: true}), false);
});

test('com successSelector, só o seletor visível abre: a página de bloqueio com cookie de flash não passa', () => {
  const blocked = {...base, hiddenReads: 4, left: true, changed: true, successRequired: true, successVisible: false};
  assert.equal(loginOpened(blocked), false);
  assert.equal(loginOpened({...blocked, successVisible: true}), true);
});

test('falha HTTP impede confirmar a sessão, mesmo com seletor', () => {
  assert.equal(loginOpened({...base, rejected: true, successRequired: true, successVisible: true}), false);
});

test('cookie mudado ou novo é detectado; páginas iguais ignoram a barra final', () => {
  const before = cookieMap([{domain: 'a.local', path: '/', name: '__Host-csrf', value: 'x'}]);
  assert.equal(cookieChanged(before, [{domain: 'a.local', path: '/', name: '__Host-csrf', value: 'x'}]), false);
  assert.equal(cookieChanged(before, [{domain: 'a.local', path: '/', name: '__Host-session', value: 's'}]), true);
  assert.equal(samePage(new URL('https://a.local/entrar/'), new URL('https://a.local/entrar')), true);
  assert.equal(samePage(new URL('https://a.local/painel'), new URL('https://a.local/entrar')), false);
  assert.equal(samePage(new URL('https://a.local/#/entrar?volta=1'), new URL('https://a.local/#/entrar/')), true);
  assert.equal(samePage(new URL('https://a.local/#/painel'), new URL('https://a.local/#/entrar')), false);
  assert.equal(samePage(new URL('https://a.local/entrar?view=console'), new URL('https://a.local/entrar')), true);
  assert.equal(samePage(new URL('https://a.local/entrar?returnTo=%2Fpainel'), new URL('https://a.local/entrar')), true);
  assert.equal(samePage(new URL('https://a.local/entrar#formulario'), new URL('https://a.local/entrar')), true);
  assert.equal(samePage(new URL('https://a.local/#!/privado'), new URL('https://a.local/')), true);
});

test('a decisão da captura usa os caminhos sem query e o marcador apenas nas rotas declaradas', async () => {
  const origin = 'https://a.local';
  const login = {path: '/', usernameSelector: '#email', passwordSelector: '#senha', submitSelector: '#entrar',
    successSelector: '#painel-pronto', successRoutes: ['/painel']};
  const shown = new Set<string>();
  const frame = {
    locator: (selector: string) => ({filter: () => ({count: () => Number(shown.has(selector)), nth: () => ({evaluate: async () => true})})}),
    childFrames: () => [],
  };
  const check = (requested: string, final: string, successRoutes = login.successRoutes) => pageShowsLogin(
    {...frame, mainFrame: () => frame, url: () => origin + final}, origin + requested, {...login, successRoutes});
  shown.add('#email');
  assert.equal(await check('/protegida', '/?destino=protegida'), true);
  assert.equal(await check('/protegida', '/?destino=protegida#/email'), false);
  assert.equal(await check('/#/privado', '/?reauth=1'), true);
  assert.equal(await check('/', '/?locale=pt'), false);
  assert.equal(await check('/painel', '/painel?origem=inicio'), true);
  assert.equal(await check('/#/privado', '/#/privado', ['/']), false);
  assert.equal(await check('/', '/?locale=pt#formulario', ['/']), true);
  assert.equal(await check('/#/privado', '/?locale=pt#/privado?aba=1', ['/#/privado']), true);
  shown.add('#painel-pronto');
  assert.equal(await check('/painel', '/painel'), false);
  assert.equal(await check('/protegida', '/'), true);
  shown.add('#entrar');
  shown.add('#senha');
  assert.equal(await check('/painel', '/painel'), true);
});

test('a tela de login fora da raiz e as rotas declaradas públicas abrem sem sessão', () => {
  const login = {path: '/entrar/'};
  assert.equal(publicRoute('https://a.local/entrar', login), true, 'login.path com barra final');
  assert.equal(publicRoute('https://a.local/entrar/?volta=%2Fpainel', login), true);
  assert.equal(publicRoute('https://a.local/painel', login), false);
  assert.equal(publicRoute('https://a.local/entrar-agora', login), false);
  assert.equal(publicRoute('https://a.local/#/entrar?x=1', {path: '/#/entrar/'}), true);
  assert.equal(publicRoute('https://a.local/', {path: '/'}), false, 'a raiz pode ser login e painel ao mesmo tempo');
  assert.equal(publicRoute('https://a.local/', {path: '/'}, true), true, 'a raiz só abre sem sessão se for declarada');
  assert.equal(publicRoute('https://a.local/sobre', login, true), true);
  assert.equal(publicRoute('https://a.local/sobre', {}), false, 'sem login.path nada é público por omissão');
});

test('login.path com barra final ainda reconhece a perda de sessão; a própria tela de login não conta', async () => {
  const origin = 'https://a.local';
  const login = {path: '/entrar/', usernameSelector: '#email', passwordSelector: '#senha', submitSelector: '#entrar'};
  const shown = new Set<string>();
  const frame = {
    locator: (selector: string) => ({filter: () => ({count: () => Number(shown.has(selector)), nth: () => ({evaluate: async () => true})})}),
    childFrames: () => [],
  };
  const check = (requested: string, final: string, sessionRequired = false) => pageShowsLogin(
    {...frame, mainFrame: () => frame, url: () => origin + final}, origin + requested, login, sessionRequired);
  assert.equal(await check('/painel', '/entrar'), true, 'redirecionado ao login sem formulário visível');
  assert.equal(await check('/painel', '/entrar/?volta=painel'), true);
  assert.equal(await check('/painel', '/painel'), false);
  shown.add('#email').add('#senha').add('#entrar');
  assert.equal(await check('/entrar', '/entrar'), false, 'a tela de login pedida mostra o formulário');
  assert.equal(await check('/entrar/', '/entrar'), false);
  assert.equal(await check('/painel', '/painel'), true, 'o formulário numa rota protegida continua sendo login');
  // Célula com sessão na própria rota de login: o atalho não vale, a sessão perdida aparece.
  assert.equal(await check('/entrar', '/entrar', true), true, 'com sessão exigida, o formulário na tela de login é sessão perdida');
  shown.clear();
  assert.equal(await check('/entrar', '/entrar', true), false, 'com sessão exigida e sem formulário, a sessão continua');
});

const playwrightCore = new URL('../upstream/cezar/node_modules/playwright-core/index.mjs', import.meta.url);
const hostChrome = '/usr/bin/google-chrome';
test('formulário com opacity:0 num ancestral ou dentro de [inert] não conta como visível', {
  skip: !existsSync(playwrightCore) || !existsSync(hostChrome),
}, async () => {
  const {chromium} = await import(playwrightCore.href) as {chromium: {launch(options: object): Promise<{
    newPage(): Promise<{route(url: string, handler: (route: {fulfill(options: object): Promise<void>}) => Promise<void>): Promise<void>;
      goto(url: string): Promise<unknown>; url(): string; mainFrame(): unknown}>; close(): Promise<void>}>}};
  const browser = await chromium.launch({executablePath: hostChrome, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage();
    const form = '<form><input id="email"><input id="senha" type="password"><button id="entrar">Entrar</button></form>';
    const pages: Record<string, string> = {
      '/claro': form,
      '/transparente': `<div style="opacity:0"><section>${form}</section></div>`,
      '/inerte': `<div inert>${form}</div>`,
      '/sombra': `<div id="host" style="opacity:0"></div><script>host.attachShadow({mode:"open"}).innerHTML = ${JSON.stringify(form)}</script>`,
      '/meio': `<div style="opacity:0.5">${form}</div>`,
    };
    await page.route('https://a.local/**', async route => {
      const path = new URL((route as unknown as {request(): {url(): string}}).request().url()).pathname;
      await route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>${pages[path] ?? ''}</body></html>`});
    });
    const login = {path: '/entrar', usernameSelector: '#email', passwordSelector: '#senha', submitSelector: '#entrar'};
    const showsLogin = async (path: string) => {
      await page.goto(`https://a.local${path}`);
      return pageShowsLogin(page, `https://a.local${path}`, login);
    };
    assert.equal(await showsLogin('/claro'), true);
    assert.equal(await showsLogin('/meio'), true, 'opacidade parcial continua visível');
    assert.equal(await showsLogin('/transparente'), false);
    assert.equal(await showsLogin('/inerte'), false);
    assert.equal(await showsLogin('/sombra'), false, 'o ancestral fora do Shadow DOM também conta');
  } finally {
    await browser.close();
  }
});

test('a senha é achada crua, curta, escapada no JSON, codificada e em base64', () => {
  const user = 'admin@example.test';
  for (const password of ['abc', 'abc"12\\3', 'p@ss word+1', 'senha-longa-123']) {
    // O valor gravado; o JSON do storageState escapa aspas e barras da forma crua.
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({p: password}).toString().slice(2),
      Buffer.from(`${user}:${password}`).toString('base64url'),
    ];
    for (const form of forms) {
      const body = JSON.stringify({origins: [{localStorage: [{name: 't', value: `x${form}y`}]}]});
      assert.equal(bodyLeaksPassword(body, user, password), true, `${password} como ${form}`);
    }
  }
  assert.equal(bodyLeaksPassword(JSON.stringify({cookies: [{name: 's', value: 'opaco'}]}), user, 'senha-longa-123'), false);
});

test('depois do fechamento, um contêiner criado tarde ainda é removido', async () => {
  resetDesignContainersForTest();
  const removed: string[] = [];
  setDesignContainerRemoverForTest(async name => { removed.push(name); });
  const early = claimDesignContainer();
  await closeDesignContainers();
  assert.deepEqual(removed, [early]);
  // O run() em segundo plano termina depois da limpeza: a liberação remove de novo, pelo nome.
  await releaseDesignContainer(early);
  assert.deepEqual(removed, [early, early]);
  assert.throws(() => claimDesignContainer(), /DESIGN_SESSION_CLOSED/);
  resetDesignContainersForTest();
});

test('o --ca exige a rede de homologação interna', async () => {
  const refused = (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_TRUST_CA_NETWORK';
  await assertInternalDesignNetwork(async () => 'true\n');
  await assert.rejects(assertInternalDesignNetwork(async () => 'false\n'), refused);
  await assert.rejects(assertInternalDesignNetwork(async () => { throw new Error('no such network'); }), refused);
});

test('a limpeza tira o sticky das pastas próprias, apaga tudo e não segue link', async () => {
  const {chmod, mkdir, mkdtemp, writeFile, symlink, stat} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {designScratchRoot, removeDesignScratch} = await import('../src/design-containers.ts');
  const outside = await mkdtemp(join(tmpdir(), 'design-fora-'));
  await writeFile(join(outside, 'manter.txt'), 'x');
  const root = await mkdtemp(join(tmpdir(), 'design-login-'));
  await mkdir(join(root, 'out'));
  await chmod(join(root, 'out'), 0o1777);
  await writeFile(join(root, 'out', 'state.json'), '{}');
  await symlink(outside, join(root, 'out', 'link'));
  // O estado do caminho da imagem (out/state.json) e o do host (state.json) acham a mesma raiz.
  assert.equal(await designScratchRoot(join(root, 'out', 'state.json')), root);
  assert.equal(await designScratchRoot(join(root, 'state.json')), root);
  // Fora de uma pasta design-* filha do tmp, nada é apagado.
  assert.equal(await designScratchRoot(join(outside, 'manter.txt')), undefined);
  assert.equal(await removeDesignScratch(tmpdir()), false);
  assert.equal(await removeDesignScratch(outside), false);
  assert.equal(await removeDesignScratch(join(root, 'out')), false, 'só a raiz, nunca uma subpasta');
  assert.equal((await stat(join(outside, 'manter.txt'))).isFile(), true);
  assert.equal(await removeDesignScratch(root), true);
  await assert.rejects(stat(root));
  assert.equal((await stat(join(outside, 'manter.txt'))).isFile(), true);
  const {rm} = await import('node:fs/promises');
  await rm(outside, {recursive: true, force: true});
});
