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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://design-lab.local');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // O documento só sai depois de 5,2s para o LCP observado passar de 4s.
    setTimeout(() => sendFile(res, 'public/index.html'), 5200);
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
