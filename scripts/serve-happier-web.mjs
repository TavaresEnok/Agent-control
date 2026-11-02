// Serves the unmodified exported Happier application; no replacement chat UI.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const root = resolve('upstream/happier/apps/ui/dist');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const target = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (target !== root && !target.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
    const file = existsSync(target) && statSync(target).isFile() ? target : root + '/index.html';
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(500); res.end(); }
}).listen(18400, '127.0.0.1', () => console.log('HAPPIER_ORIGINAL_WEB_READY'));
