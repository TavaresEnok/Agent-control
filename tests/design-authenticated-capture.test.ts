import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {designScratchRoot, removeDesignScratch} from '../src/design-containers.ts';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {DesignLogin} from '../src/design-discover.ts';
import {openDesignBrowser, writeDesignLoginState} from '../src/design-browser.ts';
import {captureScreens} from '../src/design-capture.ts';
import {promisify} from 'node:util';
import {executeDesignImage, interpretDesignImageDocument} from '../src/design-image-run.ts';
import {designExamStatus} from '../src/personal-design-cli.ts';

const image = process.env.AC_DESIGN_CAPTURE_LAB_IMAGE;
const password = 'synthetic-capture-password';
const exec = promisify(execFile);

test('captura e ferramentas usam sessão em todas as rotas e descartam a tela de login', {skip: !image}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-auth-lab-'));
  const name = `ac-design-test-${randomUUID()}`;
  const origin = `http://${name}.local:8080`;
  let state: string | undefined;
  try {
    await writeFile(join(directory, 'serve.mjs'), `
      import {createServer} from 'node:http';
      const form = '<form method="post" action="/acesso"><input id="user" name="user"><input id="pass" name="pass" type="password"><button type="button" onclick="this.form.requestSubmit()">Entrar</button></form>';
      const visits = new Map();
      const db = 'const open = indexedDB.open("auth", 1); open.onupgradeneeded = () => open.result.createObjectStore("tokens");';
      let generation = 0;
      let validCookie;
      let expired;
      const send = (res, body) => {
        res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
        res.end('<!doctype html><html lang="pt-BR"><title>Laboratório</title><main>' + body + '</main></html>');
      };
      createServer(async (req, res) => {
        const redirect = path => { res.writeHead(303, {location: path}); res.end(); };
        if (req.url === '/acesso' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const fields = new URLSearchParams(body);
          if (fields.get('user') !== 'laboratorio' || fields.get('pass') !== ${JSON.stringify(password)}) {
            return send(res, form);
          }
          validCookie = 'lab=' + ++generation;
          res.writeHead(200, {'set-cookie': validCookie + '; Path=/; HttpOnly', 'content-type': 'text/html'});
          return res.end('<script>localStorage.lab = "local"; sessionStorage.lab = "session"; ' + db +
            'open.onsuccess = () => { const tx = open.result.transaction("tokens", "readwrite"); tx.objectStore("tokens").put("synthetic-token", "session"); tx.oncomplete = () => location.replace("/pt-BR/painel"); };</script>');
        }
        if (req.url === '/') {
          const home = validCookie && req.headers.cookie === validCookie ? '<article>Conta aberta</article>' : form;
          const email = '<form><input type="email"><button>Continuar</button></form>';
          return send(res, '<script>document.currentScript.insertAdjacentHTML("afterend", location.hash.includes("?") ? ' +
            JSON.stringify(email) + ' : ' + JSON.stringify(home) + ')</script>');
        }
        if (req.url === '/acesso') return redirect('/#/entrar');
        if (req.url === '/publico') return redirect('/pt-BR/publico');
        if (req.url === '/pt-BR/publico') return send(res, form);
        if (req.url === '/renovavel' && !expired) expired = validCookie;
        if (req.url === '/expirada' || req.headers.cookie !== validCookie || (req.url === '/renovavel' && req.headers.cookie === expired)) return redirect('/#/entrar?origem=protegida');
        if (req.url === '/painel' && validCookie === 'lab=1') {
          validCookie = 'lab=rotated';
          res.setHeader('set-cookie', validCookie + '; Path=/; HttpOnly');
        }
        if (req.url === '/painel') return redirect('/pt-BR/painel');
        if (req.url === '/formulario') return send(res, form);
        if (req.url === '/shadow') return send(res, '<div id="host"></div><script>' +
          'host.attachShadow({mode:"open"}).innerHTML = ' + JSON.stringify(form) + '</script>');
        if (req.url === '/frame') return send(res, '<iframe src="/shadow"></iframe>');
        if (req.url === '/trocar-senha') return send(res, '<form><input id="pass" type="password"><button>Trocar senha</button></form>' +
          '<form><h1>Configurar 2FA</h1><input autocomplete="one-time-code"><button>Salvar</button></form><iframe hidden src="/formulario"></iframe>');
        if (req.url === '/clique-401') return send(res, '<a id="acao" href="/negada">Abrir</a>');
        if (req.url === '/clique-sair') return send(res, '<a id="acao" href="/sessao-removida" onclick="sessionStorage.clear()">Sair</a>');
        if (req.url === '/sessao-removida') return send(res, '<script>if (!sessionStorage.lab) location.replace("/#/entrar?voltar=sessao")</script><h1>Painel</h1>');
        if (req.url === '/negada') {
          res.writeHead(401, {'content-type': 'text/html'}); return res.end('<h1>Sessão expirada</h1>');
        }
        if (['/so-pa11y', '/so-lighthouse', '/so-regua', '/so-teclado'].includes(req.url)) {
          const visit = (visits.get(req.url) ?? 0) + 1;
          visits.set(req.url, visit);
          // Playwright faz a captura e três passagens de régua/teclado.
          // Depois vêm os dois runners do Pa11y e os dois formatos do Lighthouse.
          if (req.url === '/so-pa11y' && visit >= 5 && visit <= 6) return send(res, form);
          if (req.url === '/so-lighthouse' && visit >= 7) {
            res.writeHead(401, {'content-type': 'text/html'}); return res.end('<h1>Sessão expirada</h1>');
          }
          if (req.url === '/so-regua' && visit === 2) return redirect('/#/entrar?voltar=regua');
          if (req.url === '/so-regua' && visit === 4) {
            return send(res, '<h1>Painel autenticado</h1><script>setTimeout(() => location.replace("/#/entrar?voltar=regua"), 300)</script>');
          }
          if (req.url === '/so-teclado' && visit === 3) {
            res.writeHead(401, {'content-type': 'text/html'}); return res.end('<h1>Sessão expirada</h1>');
          }
        }
        if (req.url === '/spa') return send(res, '<h1>SPA autenticada</h1><script>' + db +
          'if (localStorage.lab !== "local" || sessionStorage.lab !== "session") location.replace("/acesso");' +
          'open.onsuccess = () => { const read = open.result.transaction("tokens").objectStore("tokens").get("session"); read.onsuccess = () => { if (read.result !== "synthetic-token") location.replace("/acesso"); }; };' +
          'addEventListener("resize", () => { if (innerWidth === 1280 && innerHeight === 1024) location.replace("/acesso"); });</script>');
        return send(res, '<h1>Painel autenticado</h1><a href="/painel">Painel</a><a href="/spa">SPA</a>');
      }).listen(8080, '0.0.0.0');
    `);
    const repository = join(directory, 'repo');
    await mkdir(repository);
    await exec('docker', ['run', '-d', '--rm', '--pull', 'never', '--name', name,
      '--network', 'design-homologation', '--network-alias', `${name}.local`,
      '--mount', `type=bind,source=${directory}/serve.mjs,destination=/serve.mjs,readonly`,
      '--entrypoint', 'node', image!, '/serve.mjs']);
    const url = origin + '/#/entrar';
    const renewLogin = () => writeDesignLoginState(url, {
      username: 'laboratorio', password, usernameSelector: '#user', passwordSelector: '#pass',
      submitSelector: 'text=Entrar', successSelector: 'h1',
    }, image);
    state = await renewLogin();
    const accepted = ['/painel', '/#/entrar', '/renovavel', '/so-lighthouse', '/so-pa11y', '/so-regua', '/so-teclado', '/spa', '/trocar-senha'];
    const failedActions = ['/clique-401', '/clique-sair'];
    const rejected = ['/expirada', '/formulario', '/frame'];
    let renewals = 0;
    const exam = await executeDesignImage({
      image: image!, targetUrl: url, repository, loginState: state,
      renewLogin() { renewals++; return renewLogin(); },
      plan: {routes: [
        ...[...accepted, ...rejected].map(route => ({route, states: ['padrao']})),
        ...failedActions.map(route => ({route, states: [{name: 'erro', acoes: ['clicar #acao']}]})),
      ], viewports: [375]},
    });
    assert.equal(exam.ok, true, exam.notes.join(' '));
    assert.equal(renewals, 1 + rejected.length + failedActions.length);
    const raw = JSON.stringify(exam.document);
    assert.equal(raw.includes(password), false);
    const doc = JSON.parse(raw) as {
      screenshots: {route: string; fileName: string; state: string}[];
      unavailable: {route: string; status: number; code: string}[];
      auditLoginFailures: {tool: string; route: string}[];
      reports: Record<'axe' | 'pa11y' | 'lighthouse', {route: string}[]> & {
        render: {route: string; viewport: number; motion?: unknown}[];
        keyboard: {file: string}[];
      };
      computed: {route: string}[];
    };
    assert.deepEqual(doc.screenshots.map(row => [row.route, row.state]), accepted.map(route => [route, 'padrao']));
    assert.deepEqual(exam.shots.map(shot => shot.fileName).sort(), doc.screenshots.map(row => row.fileName).sort());
    assert.deepEqual(doc.unavailable.map(row => [row.route, row.status]), [...rejected, ...failedActions].map(route => [route, 401]));
    assert.ok(doc.unavailable.every(row => row.code === 'DESIGN_CAPTURE_LOGIN_FAILED'));
    const {axe, pa11y, lighthouse, render} = doc.reports;
    for (const [tool, reports] of Object.entries({axe, pa11y, lighthouse, render, computed: doc.computed})) {
      assert.deepEqual([...new Set(reports.map(row => row.route))].sort(), [...accepted, ...(['pa11y', 'lighthouse', 'render'].includes(tool) ? failedActions : [])]
        .filter(route => route !== `/so-${tool}`).sort(), tool);
    }
    assert.equal(pa11y.filter(row => row.route === '/spa').length, 2);
    assert.equal(lighthouse.filter(row => row.route === '/spa').length, 2);
    assert.ok(doc.reports.render.some(row => row.route === '/painel' && row.viewport === 320));
    assert.ok(doc.reports.keyboard.some(row => row.file.startsWith('/painel ')));
    assert.ok(doc.reports.render.some(row => row.route === '/so-regua' && row.viewport === 375));
    assert.equal(doc.reports.render.some(row => row.route === '/so-regua' && (row.viewport === 320 || row.motion)), false);
    assert.equal(doc.reports.keyboard.some(row => row.file.startsWith('/so-teclado ')), false);
    const failures = [
      {route: '/so-regua', tool: 'render'},
      {route: '/so-teclado', tool: 'keyboard'},
      {route: '/so-pa11y', tool: 'pa11y'},
      {route: '/so-lighthouse', tool: 'lighthouse'},
    ];
    for (const failure of failures) {
      assert.deepEqual(doc.auditLoginFailures.filter(row => row.route === failure.route), [failure]);
      const result = interpretDesignImageDocument({...doc, unavailable: [], auditLoginFailures: [failure]});
      assert.equal(designExamStatus(result).code, 1, failure.tool);
    }
    for (const route of failedActions) {
      const result = interpretDesignImageDocument({...doc, unavailable: doc.unavailable.filter(row => row.route === route), auditLoginFailures: []});
      assert.equal(designExamStatus(result).code, 1, route);
    }
    const publicDoc = await executeDesignImage({image: image!, targetUrl: origin, repository,
      plan: {routes: [{route: '/publico'}], viewports: [375]}});
    assert.deepEqual(publicDoc.shots.map(row => row.route), ['/publico']);
    assert.equal(designExamStatus(publicDoc).code, 0);
  } finally {
    await exec('docker', ['rm', '-f', name]).catch(() => {});
    const scratch = state && await designScratchRoot(state);
    if (scratch) await removeDesignScratch(scratch);
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium no host reconhece a perda de sessão e o UID da imagem lê seu estado', {skip: !image}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'design-auth-host-'));
  const visits = new Set<string>();
  let renewVisits = 0;
  const server = createServer(async (req, res) => {
    visits.add(req.url ?? '');
    const form = '<form><input id="user"><input id="pass" type="password"><button type="button">Entrar</button></form>';
    const redirect = (url: string) => {
      res.writeHead(303, {location: url}).end();
    };
    const html = (body: string, status = 200) => {
      res.writeHead(status, {'content-type': 'text/html'}).end('<!doctype html><html><div id="root">' + body + '</div></html>');
    };
    if (req.url === '/' && req.headers.cookie === 'lab=opened') {
      html('<h1>Painel autenticado na URL do login</h1>');
    } else if (req.url === '/?email=1') {
      assert.equal(req.headers.cookie, 'lab=opened');
      html('<form><input type="email"><button>Continuar</button></form>');
    } else if (req.url === '/?destino=painel') {
      html('<h1>Entrar</h1><p>Entre para continuar.</p>');
    } else if (req.url === '/' || req.url === '/?sem-cookie=1') {
      const cookie = req.url === '/' ? 'document.cookie = "lab=opened; Path=/"; ' : '';
      const target = req.url === '/' ? '/painel' : '/painel-idb';
      html(form + '<script>document.querySelector("button").onclick = () => {' +
        'if (document.querySelector("#user").value !== "laboratorio" || document.querySelector("#pass").value !== ' +
        JSON.stringify(password) + ') { location.replace("/negada"); return; }' +
        cookie + 'const open = indexedDB.open("host-auth", 1);' +
        'open.onupgradeneeded = () => open.result.createObjectStore("tokens");' +
        'open.onsuccess = () => { const tx = open.result.transaction("tokens", "readwrite");' +
        'tx.objectStore("tokens").put("synthetic-token", "session"); tx.oncomplete = () => location.replace(' + JSON.stringify(target) + '); }; };</script>');
    } else if (req.url === '/negada') {
      html('<h1>Sessão expirada</h1>', 401);
    } else if (req.url === '/painel-idb') {
      html('<h1>Painel IndexedDB</h1>');
    } else if (req.headers.cookie !== 'lab=opened' || req.url === '/expirada') {
      redirect('/?destino=painel');
    } else if (req.url === '/protegida') {
      redirect('/?email=1');
    } else if (req.url === '/renovavel' && ++renewVisits === 1) {
      redirect('/?email=1');
    } else if (req.url === '/painel') {
      html('<h1 id="painel-pronto">Painel</h1><a id="acao" href="/negada">Abrir</a>');
    } else if (req.url === '/sem-marcador') {
      html('<h1>Outra página</h1>');
    } else if (req.url === '/trocar-senha') {
      html('<form><input id="pass" type="password"><button type="submit">Trocar senha</button></form>');
    } else if (req.url === '/formulario') {
      html(form);
    } else if (req.url === '/senha-apenas') {
      html('<form><input type="password"><button>Entrar</button></form>');
    } else if (req.url === '/shadow') {
      html('<div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML = ' +
        JSON.stringify(form) + '</script>');
    } else if (req.url === '/frame') {
      html('<iframe src="/formulario"></iframe>');
    } else if (req.url === '/2fa') {
      html('<form><h1>Configurar 2FA</h1><input autocomplete="one-time-code"><button>Salvar</button></form>');
    } else {
      html('<h1>Painel autenticado</h1><a id="acao" href="/negada">Abrir</a>');
    }
  });
  let state: string | undefined;
  let idbState: string | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const hostOrigin = `http://127.0.0.1:${address.port}`;
    const loginUrl = hostOrigin + '/';
    const login = {
      username: 'laboratorio', password, usernameSelector: '#user', passwordSelector: '#pass',
      submitSelector: 'text=Entrar', successSelector: '#painel-pronto', successRoutes: ['/painel', '/sem-marcador'],
    };
    state = await writeDesignLoginState(loginUrl, login, image);
    const mounted = await exec('docker', [
      'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '65532:65532', '--read-only',
      '--mount', `type=bind,source=${state},destination=/login/state.json,readonly`,
      '--entrypoint', 'cat', image!, '/login/state.json',
    ]);
    assert.equal(mounted.stdout.includes(password), false);
    const exported = JSON.parse(mounted.stdout);
    assert.equal(exported.designLogin.path, '/');
    assert.equal(exported.origins[0].indexedDB[0].name, 'host-auth');
    await assert.rejects(writeDesignLoginState(loginUrl, {...login, password: 'synthetic-wrong-password', successSelector: undefined}),
      {message: 'DESIGN_CAPTURE_LOGIN_FAILED'});

    idbState = await writeDesignLoginState(loginUrl + '?sem-cookie=1', {...login, successSelector: undefined});
    const fromIdb = JSON.parse(await readFile(idbState, 'utf8'));
    assert.deepEqual(fromIdb.cookies, []);
    assert.equal(fromIdb.origins[0].indexedDB[0].name, 'host-auth');

    const plan = (route: string) => ({
      screenId: 'lab', route, viewport: 375, theme: 'claro', state: 'padrao', fileName: `${route.slice(1) || 'inicio'}.png`,
    } as const);
    const capture = async (plans: Parameters<typeof captureScreens>[2], config: DesignLogin = login) => {
      const browser = await openDesignBrowser(loginUrl);
      try {
        return await captureScreens(browser.driver, hostOrigin, plans, directory, {login: config, loginUrl});
      } finally {
        await browser.close();
      }
    };
    const accepted = ['/', '/renovavel', '/trocar-senha', '/2fa', '/senha-apenas'];
    const {successSelector, successRoutes, ...noMarker} = login;
    await t.test('a própria URL do login exibe a página autenticada sem marcador', async () => {
      assert.equal((await capture([plan('/')], noMarker)).captures.length, 1);
    });
    await t.test('marcador usado apenas para confirmar a entrada não é exigido na raiz autenticada', async () => {
      assert.equal((await capture([plan('/')], {...login, successRoutes: undefined})).captures.length, 1);
    });
    assert.deepEqual((await capture(accepted.map(plan))).captures.map(row => row.route), accepted);
    const failures = {
      '/expirada': 'redirecionamento ao login sem campo de senha',
      '/protegida': 'login por e-mail com HTTP 200 e cookie expirado ainda presente',
      '/shadow': 'formulário configurado visível em Shadow DOM aberto',
      '/formulario': 'formulário configurado servido na rota pedida',
      '/frame': 'formulário configurado dentro de iframe visível',
      '/sem-marcador': 'marcador ausente em rota que o exige',
    };
    for (const [route, description] of Object.entries(failures)) {
      await t.test(description, async () => {
        await assert.rejects(capture([plan(route)]), {code: 'DESIGN_CAPTURE_LOGIN_FAILED'});
        assert.ok(visits.has(route), route);
      });
    }
    await assert.rejects(capture([{
      ...plan('/painel'), state: 'erro', reach: {kind: 'acoes', steps: ['clicar #acao']},
    }]), {code: 'DESIGN_CAPTURE_LOGIN_FAILED'});
    assert.ok(visits.has('/negada'));
    assert.equal(renewVisits, 2);
    assert.deepEqual((await readdir(directory)).sort(), ['2fa.png', 'capturas.json', 'inicio.png', 'renovavel.png', 'senha-apenas.png', 'trocar-senha.png']);
  } finally {
    server.close();
    if (state) await rm(dirname(state), {recursive: true, force: true});
    if (idbState) await rm(dirname(idbState), {recursive: true, force: true});
    await rm(directory, {recursive: true, force: true});
  }
});
