import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const image = process.env.AC_DESIGN_CAPTURE_LAB_IMAGE;
const origin = 'http://127.0.0.1:8080';
const password = 'synthetic-capture-password';
const exec = promisify(execFile);

test('captura e ferramentas usam sessão em todas as rotas e descartam a tela de login', {skip: !image}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-auth-lab-'));
  try {
    const tools = fileURLToPath(new URL('../deploy/design-tools/', import.meta.url));
    await writeFile(join(directory, 'serve.mjs'), `
      import {createServer} from 'node:http';
      const form = '<form method="post"><input id="user" name="user"><input id="pass" name="pass" type="password"><button type="submit">Entrar</button></form>';
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
        if (req.url === '/acesso') return send(res, form);
        if (req.url === '/expirada' || req.headers.cookie !== 'lab=opened') return redirect('/acesso');
        if (req.url === '/formulario') return send(res, form);
        if (req.url === '/spa') return send(res, '<h1>SPA autenticada</h1><script>if (localStorage.lab !== "local" || sessionStorage.lab !== "session") location.replace("/acesso");</script>');
        return send(res, '<h1>Painel autenticado</h1>');
      }).listen(8080, '127.0.0.1');
    `);
    const loginDir = join(directory, 'login');
    await mkdir(loginDir, {mode: 0o700});
    await writeFile(join(loginDir, 'login.json'), JSON.stringify({
      url: origin + '/acesso', username: 'laboratorio', password,
      usernameSelector: '#user', passwordSelector: '#pass', submitSelector: 'button[type=submit]',
      successSelector: 'h1',
    }), {mode: 0o600});
    const accepted = ['/painel', '/spa'];
    const rejected = ['/expirada', '/formulario'];
    await writeFile(join(directory, 'pedido.json'), JSON.stringify({
      routes: [...accepted, ...rejected].map(route => ({route, states: ['padrao']})),
      viewports: [375],
    }));
    const mounts = ['run-exam.mjs', 'write-login-state.mjs', 'login-decision.mjs'].flatMap(name => [
      '-v', `${join(tools, name)}:/opt/design-tools/${name}:ro`,
    ]);
    await exec('docker', [
      'run', '--rm', '--init', '--pull', 'never', '--network', 'none', '--user', `${process.getuid?.()}:${process.getgid?.()}`,
      '-e', 'HOME=/tmp', '-e', `DESIGN_TARGET_URL=${origin}`, '-v', `${directory}:/output`,
      '-v', `${loginDir}:/login`, ...mounts,
      '--entrypoint', 'sh', image!,
      '-ec', `node /output/serve.mjs &
        node /opt/design-tools/write-login-state.mjs
        cp /output/state.json /login/state.json
        rm /output/state.json
        node /opt/design-tools/run-exam.mjs`,
    ], {timeout: 240_000});
    const raw = await readFile(join(directory, 'achados-brutos.json'), 'utf8');
    assert.equal(raw.includes(password), false);
    const doc = JSON.parse(raw) as {
      screenshots: {route: string; fileName: string; state: string}[];
      unavailable: {route: string; status: number}[];
      reports: Record<'axe' | 'pa11y' | 'lighthouse' | 'render', {route: string}[]>;
      computed: {route: string}[];
    };
    assert.deepEqual(doc.screenshots.map(row => [row.route, row.state]), accepted.map(route => [route, 'padrao']));
    assert.deepEqual((await readdir(join(directory, 'capturas'))).sort(), doc.screenshots.map(row => row.fileName).sort());
    assert.deepEqual(doc.unavailable.map(row => [row.route, row.status]), rejected.map(route => [route, 401]));
    for (const [tool, reports] of Object.entries({...doc.reports, computed: doc.computed})) {
      if (!['axe', 'pa11y', 'lighthouse', 'render', 'computed'].includes(tool)) continue;
      assert.deepEqual([...new Set(reports.map(row => row.route))].sort(), accepted, tool);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
