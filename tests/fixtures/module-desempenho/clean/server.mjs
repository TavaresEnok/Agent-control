import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const html = readFileSync(join(import.meta.dirname, 'public', 'index.html'), 'utf8');
const cachedPayload = JSON.stringify({total: 42, items: 42});

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
    res.end('ok');
    return;
  }
  if (url === '/api/relatorio') {
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    res.end(cachedPayload);
    return;
  }
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(html);
});

const port = Number(process.env.PORT ?? 0);
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
