import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {openDesignBrowser, writeDesignLoginState} from '../src/design-browser.ts';
import {captureScreens} from '../src/design-capture.ts';
import {promisify} from 'node:util';
import {interpretDesignImageDocument} from '../src/design-image-run.ts';
import {designExamStatus} from '../src/personal-design-cli.ts';

const image = process.env.AC_DESIGN_CAPTURE_LAB_IMAGE;
const origin = 'http://127.0.0.1:8080';
const password = 'synthetic-capture-password';
const exec = promisify(execFile);

test('captura e ferramentas usam sessão em todas as rotas e descartam a tela de login', {skip: !image}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-auth-lab-'));
  try {
    await writeFile(join(directory, 'serve.mjs'), `
      import {createServer} from 'node:http';
      const form = '<form method="post" action="/acesso"><input id="user" name="user"><input id="pass" name="pass" type="password"><button type="button" onclick="this.form.requestSubmit()">Entrar</button></form>';
      const visits = new Map();
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
          res.writeHead(200, {'set-cookie': 'lab=opened; Path=/; HttpOnly', 'content-type': 'text/html'});
          return res.end('<script>localStorage.lab = "local"; sessionStorage.lab = "session"; location.replace("/painel");</script>');
        }
        if (req.url === '/') return send(res, '<script>if (location.hash === "#/entrar") document.currentScript.insertAdjacentHTML("afterend", ' + JSON.stringify(form) + ')</script>');
        if (req.url === '/acesso') return redirect('/#/entrar');
        if (req.url === '/publico') return redirect('/pt-BR/publico');
        if (req.url === '/pt-BR/publico') return send(res, form);
        if (req.url === '/expirada' || req.headers.cookie !== 'lab=opened') return redirect('/acesso');
        if (req.url === '/painel') return redirect('/pt-BR/painel');
        if (req.url === '/formulario') return send(res, form.replace('id="pass"', 'id="outraSenha"'));
        if (req.url === '/trocar-senha') return send(res, '<form><input id="pass" type="password"><button type="submit">Trocar senha</button></form>');
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
        if (req.url === '/spa') return send(res, '<h1>SPA autenticada</h1><script>if (localStorage.lab !== "local" || sessionStorage.lab !== "session") location.replace("/acesso");</script>');
        return send(res, '<h1>Painel autenticado</h1><a href="/painel">Painel</a><a href="/spa">SPA</a>');
      }).listen(8080, '127.0.0.1');
    `);
    const loginDir = join(directory, 'login');
    await mkdir(loginDir, {mode: 0o1777});
    await chmod(loginDir, 0o1777);
    const loginFile = join(loginDir, 'login.json');
    await writeFile(loginFile, JSON.stringify({
      url: origin + '/#/entrar', username: 'laboratorio', password,
      usernameSelector: '#user', passwordSelector: '#pass', submitSelector: 'text=Entrar',
      successSelector: 'h1',
    }), {mode: 0o600});
    await chmod(directory, 0o1777);
    await exec('setfacl', ['-m', 'u:65532:r', loginFile]);
    const accepted = ['/painel', '/so-lighthouse', '/so-pa11y', '/so-regua', '/so-teclado', '/spa', '/trocar-senha'];
    const failedActions = ['/clique-401', '/clique-sair'];
    const rejected = ['/expirada', '/formulario'];
    await writeFile(join(directory, 'pedido.json'), JSON.stringify({
      routes: [
        ...[...accepted, ...rejected].map(route => ({route, states: ['padrao']})),
        ...failedActions.map(route => ({route, states: [{name: 'erro', acoes: ['clicar #acao']}]})),
      ],
      viewports: [375],
    }));
    await exec('setfacl', ['-m', 'u:65532:rw', join(directory, 'pedido.json')]);
    const publicDir = join(directory, 'publico');
    await mkdir(publicDir, {mode: 0o1777});
    await chmod(publicDir, 0o1777);
    await writeFile(join(publicDir, 'pedido.json'), JSON.stringify({
      routes: [{route: '/publico', states: ['padrao']}], viewports: [375],
    }));
    await exec('docker', [
      'run', '--rm', '--init', '--pull', 'never', '--network', 'none', '--user', '65532:65532',
      '-e', 'HOME=/tmp', '-e', `DESIGN_TARGET_URL=${origin}`, '-v', `${directory}:/output`,
      '-v', `${loginDir}:/login`, '--entrypoint', 'sh', image!,
      '-ec', `trap 'chmod 0777 /output/capturas /output/publico/capturas /tmp/capturas 2>/dev/null || true' EXIT
        node /output/serve.mjs &
        node /opt/design-tools/write-login-state.mjs
        mv /output/state.json /login/state.json
        /usr/local/bin/design-entrypoint.sh
        rm /login/state.json
        mv /output/capturas /output/achados-brutos.json /tmp/
        cat /output/publico/pedido.json > /output/pedido.json
        /usr/local/bin/design-entrypoint.sh
        mv /output/capturas /output/achados-brutos.json /output/publico/
        mv /tmp/capturas /tmp/achados-brutos.json /output/`,
    ], {timeout: 480_000});
    const raw = await readFile(join(directory, 'achados-brutos.json'), 'utf8');
    assert.equal(raw.includes(password), false);
    const doc = JSON.parse(raw) as {
      screenshots: {route: string; fileName: string; state: string}[];
      unavailable: {route: string; status: number}[];
      auditLoginFailures: {tool: string; route: string}[];
      reports: Record<'axe' | 'pa11y' | 'lighthouse', {route: string}[]> & {
        render: {route: string; viewport: number; motion?: unknown}[];
        keyboard: {file: string}[];
      };
      computed: {route: string}[];
    };
    assert.deepEqual(doc.screenshots.map(row => [row.route, row.state]), accepted.map(route => [route, 'padrao']));
    assert.deepEqual((await readdir(join(directory, 'capturas'))).sort(), doc.screenshots.map(row => row.fileName).sort());
    assert.deepEqual(doc.unavailable.map(row => [row.route, row.status]), [...rejected, ...failedActions].map(route => [route, 401]));
    const {axe, pa11y, lighthouse, render} = doc.reports;
    for (const [tool, reports] of Object.entries({axe, pa11y, lighthouse, render, computed: doc.computed})) {
      assert.deepEqual([...new Set(reports.map(row => row.route))].sort(), [...accepted, ...(['pa11y', 'lighthouse', 'render'].includes(tool) ? failedActions : [])]
        .filter(route => route !== `/so-${tool}`).sort(), tool);
    }
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
    const publicDoc = interpretDesignImageDocument(JSON.parse(await readFile(join(publicDir, 'achados-brutos.json'), 'utf8')));
    assert.deepEqual(publicDoc.shotMeta.map(row => row.route), ['/publico']);
    assert.equal(designExamStatus(publicDoc).code, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium no host reconhece a perda de sessão e o UID da imagem lê seu estado', {skip: !image}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-auth-host-'));
  const visits = new Set<string>();
  const server = createServer(async (req, res) => {
    visits.add(req.url ?? '');
    const form = '<form><input id="user"><input id="pass" type="password"><button type="button">Entrar</button></form>';
    const redirect = (url: string) => {
      res.writeHead(303, {location: url}).end();
    };
    const html = (body: string, status = 200) => {
      res.writeHead(status, {'content-type': 'text/html'}).end('<!doctype html><html><div id="root">' + body + '</div></html>');
    };
    if (req.url === '/') {
      html('<span>Laboratório</span><script>if (location.hash === "#/entrar") {' +
        'document.currentScript.insertAdjacentHTML("beforebegin", ' + JSON.stringify(form) + ');' +
        'document.querySelector("button").onclick = () => {' +
        'if (document.querySelector("#user").value === "laboratorio" && document.querySelector("#pass").value === ' +
        JSON.stringify(password) + ') { document.cookie = "lab=opened; Path=/"; location.replace("/alias"); } }; }</script>');
    } else if (req.headers.cookie !== 'lab=opened' || req.url === '/expirada') {
      redirect('/#/entrar?voltar=painel');
    } else if (req.url === '/alias') {
      redirect('/painel');
    } else if (req.url === '/trocar-senha') {
      html('<form><input id="pass" type="password"><button type="submit">Trocar senha</button></form>');
    } else if (req.url === '/formulario') {
      html(form.replace('id="pass"', 'id="outraSenha"'));
    } else if (req.url === '/negada') {
      html('<h1>Sessão expirada</h1>', 401);
    } else {
      html('<h1>Painel autenticado</h1><a id="acao" href="/negada">Abrir</a>');
    }
  });
  let state: string | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const hostOrigin = `http://127.0.0.1:${address.port}`;
    const loginUrl = hostOrigin + '/#/entrar';
    const login = {
      username: 'laboratorio', password, usernameSelector: '#user', passwordSelector: '#pass',
      submitSelector: 'text=Entrar', successSelector: 'h1',
    };
    state = await writeDesignLoginState(loginUrl, login, image);
    const mounted = await exec('docker', [
      'run', '--rm', '--pull', 'never', '--network', 'none', '--user', '65532:65532', '--read-only',
      '--mount', `type=bind,source=${state},destination=/login/state.json,readonly`,
      '--entrypoint', 'cat', image!, '/login/state.json',
    ]);
    assert.equal(mounted.stdout.includes(password), false);
    assert.equal(JSON.parse(mounted.stdout).designLogin.path, '/#/entrar');

    const plan = (route: string) => ({
      screenId: 'lab', route, viewport: 375, theme: 'claro', state: 'padrao', fileName: `${route.slice(1)}.png`,
    } as const);
    const capture = async (plans: Parameters<typeof captureScreens>[2]) => {
      const browser = await openDesignBrowser(loginUrl);
      try {
        return await captureScreens(browser.driver, hostOrigin, plans, directory, {login, loginUrl});
      } finally {
        await browser.close();
      }
    };
    const accepted = ['/alias', '/trocar-senha'];
    assert.deepEqual((await capture(accepted.map(plan))).captures.map(row => row.route), accepted);
    for (const route of ['/expirada', '/formulario']) {
      await assert.rejects(capture([plan(route)]), {code: 'DESIGN_CAPTURE_LOGIN_FAILED'});
      assert.ok(visits.has(route), route);
    }
    await assert.rejects(capture([{
      ...plan('/painel'), state: 'erro', reach: {kind: 'acoes', steps: ['clicar #acao']},
    }]), {code: 'DESIGN_CAPTURE_LOGIN_FAILED'});
    assert.ok(visits.has('/negada'));
    assert.deepEqual((await readdir(directory)).sort(), ['alias.png', 'capturas.json', 'trocar-senha.png']);
  } finally {
    server.close();
    if (state) await rm(dirname(state), {recursive: true, force: true});
    await rm(directory, {recursive: true, force: true});
  }
});
