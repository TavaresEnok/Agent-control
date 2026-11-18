import {createServer} from 'node:http';

export function criar() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/admin') {
      res.end('painel');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/saude') {
      res.end('ok');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}
