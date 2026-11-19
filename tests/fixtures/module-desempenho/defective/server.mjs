import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const html = readFileSync(join(import.meta.dirname, 'public', 'index.html'), 'utf8');

function computeHeavyReport() {
  const deadline = performance.now() + 220;
  let acc = 1;
  while (performance.now() < deadline) {
    for (let i = 0; i < 5000; i += 1) {
      acc = (acc * 1664525 + 1013904223) >>> 0;
    }
  }
  return {total: acc, items: 42};
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'});
    res.end('ok');
    return;
  }
  if (url === '/api/relatorio') {
    const payload = computeHeavyReport();
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end(html);
});

const port = Number(process.env.PORT ?? 0);
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
