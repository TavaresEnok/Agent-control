/** Servidor estático do laboratório. Só entrega arquivos de /srv. Atrasa /hero.jpg para o LCP e o CLS. */
import {createServer} from 'node:http';
import {readFileSync, statSync} from 'node:fs';
import {join, normalize} from 'node:path';

const root = '/srv';
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json'};

const STATE_PAGES = {
  '/estado/vazio': 'Nenhum item',
  '/estado/carregando': 'Carregando',
  '/estado/erro': 'Não foi possível carregar',
};

/*
 * Páginas plantadas da régua e do teclado. Cada defeito tem uma regra que precisa disparar.
 * /lab/sonda junta os defeitos medidos na página; os outros dois são páginas que não são o produto.
 */
const PROBE_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sonda do laboratório</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1b1b1b; background: #ffffff; }
    main { padding: 96px 16px 16px; }
    .topo { position: fixed; top: 0; left: 0; right: 0; height: 80px; background: #ffffff; border-bottom: 1px solid #d0d0d0; }
    .atalho { position: absolute; top: 24px; left: 16px; }
    .largo { width: 520px; height: 40px; background: #e8eefc; }
    .corte { display: inline-block; width: 80px; white-space: nowrap; overflow: hidden; }
    .claro { color: #ffffff; background: #1d4ed8; border: 0; padding: 12px 20px; font-size: 16px; }
    .claro:hover { color: #ffffff; background: #ffffff; }
    .gira { width: 64px; height: 64px; background: #1d4ed8; animation: pulsa 2s linear infinite; }
    @keyframes pulsa { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <a class="atalho" href="#fim">Pular para o fim</a>
  <header class="topo"><p>Topo fixo</p></header>
  <main>
    <h1>Sonda</h1>
    <div class="largo">Faixa de 520px</div>
    <p><span class="corte">Nome muito comprido do cliente</span></p>
    <img src="/lab/sumiu.png" alt="Foto do cliente" width="120" height="80">
    <p>Olá, {{cliente.nome}}</p>
    <canvas width="300" height="150"></canvas>
    <p><button class="claro" type="button">Assinar</button></p>
    <div class="gira"></div>
    <p id="fim">Fim</p>
  </main>
</body>
</html>`;

const LOGIN_PAGE = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Entrar</title></head><body><main><h1>Entrar</h1><p>Entre para continuar.</p></main></body></html>';

const OVERLAY_PAGE = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Painel</title></head><body><main><h1>Painel</h1></main><vite-error-overlay></vite-error-overlay></body></html>';

function sendHtml(res, status, html) {
  res.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  res.end(html);
}

function stateHtml(text) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${text}</title></head><body><main><h1>${text}</h1><p>${text}</p></main></body></html>`;
}

function fileFor(url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'public/index.html';
  if (path === '/painel') return 'public/painel.html';
  if (path === '/item/42') return 'public/item.html';
  if (path === '/css/site.css') return 'css/site.css';
  if (path === '/foto.png') return 'public/foto.png';
  if (Object.hasOwn(STATE_PAGES, path)) return path;
  if (path.includes('..')) return null;
  return `public${path}`;
}

function sendFile(res, relative) {
  if (relative && Object.hasOwn(STATE_PAGES, relative)) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(stateHtml(STATE_PAGES[relative]));
    return;
  }
  if (!relative) {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('não capturado');
    return;
  }
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) {
    res.writeHead(403);
    res.end('proibido');
    return;
  }
  try {
    const info = statSync(full);
    if (!info.isFile()) throw new Error('não é arquivo');
    const ext = relative.slice(relative.lastIndexOf('.'));
    res.writeHead(200, {'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(readFileSync(full));
  } catch {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('ausente');
  }
}

const LAB_USER = 'ada';
const LAB_PASSWORD = 'senha-lab-3';

function hasSession(req) {
  const header = req.headers.cookie ?? '';
  return header.split(';').some(part => part.trim() === 'ac_lab_session=aberta');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendLoggedHome(res) {
  try {
    const html = readFileSync(join(root, 'public/index.html'), 'utf8')
      .replace('</body>', '<h1 id="conta">Conta de ada aberta</h1></body>');
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(html);
  } catch {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('ausente');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://design-lab.local');
  if (req.method === 'POST' && url.pathname === '/entrar') {
    readBody(req).then(body => {
      const fields = new URLSearchParams(body);
      if (fields.get('usuario') === LAB_USER && fields.get('senha') === LAB_PASSWORD) {
        res.writeHead(303, {
          location: '/',
          'set-cookie': 'ac_lab_session=aberta; HttpOnly; Path=/; SameSite=Lax',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      res.writeHead(401, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end('não entrou');
    }).catch(() => {
      res.writeHead(401, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end('não entrou');
    });
    return;
  }
  if (url.pathname === '/lab/sonda') {
    sendHtml(res, 200, PROBE_PAGE);
    return;
  }
  if (url.pathname === '/lab/privado') {
    res.writeHead(302, {location: '/entrar', 'cache-control': 'no-store'});
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/entrar') {
    sendHtml(res, 200, LOGIN_PAGE);
    return;
  }
  if (url.pathname === '/lab/erro-dev') {
    sendHtml(res, 200, OVERLAY_PAGE);
    return;
  }
  if (url.pathname === '/conta') {
    const html = hasSession(req)
      ? '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conta</title></head><body><h1 id="conta">Conta de ada aberta</h1></body></html>'
      : '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conta</title></head><body><p>Entre para continuar</p></body></html>';
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(html);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // O documento só sai depois de 5,2s para o LCP observado passar de 4s.
    setTimeout(() => {
      if (hasSession(req)) sendLoggedHome(res);
      else sendFile(res, 'public/index.html');
    }, 5200);
    return;
  }
  if (url.pathname === '/hero.jpg') {
    setTimeout(() => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
      res.writeHead(200, {'content-type': 'image/png', 'cache-control': 'no-store'});
      res.end(png);
    }, 4500);
    return;
  }
  sendFile(res, fileFor(url));
});

server.listen(8080, '0.0.0.0');
