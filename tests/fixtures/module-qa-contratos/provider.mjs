function send(response, status, body) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
}

export default async function provider(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/catalogo' && url.searchParams.get('categoria') === 'papel') {
    return send(response, 200, {itens: [{codigo: 'lapis', preco: 2}], marca: 'MARCA-SINTETICA-NAO-PUBLICAR'});
  }
  if (request.method === 'GET' && url.pathname === '/catalogo/lapis') {
    return send(response, 200, {codigo: 'lapis', preco: 2});
  }
  if (request.method === 'GET' && url.pathname === '/catalogo/ausente') {
    return send(response, 404, {erro: 'produto-ausente'});
  }
  if (request.method === 'POST' && url.pathname === '/soma') {
    let data = '';
    for await (const chunk of request) data += chunk;
    const {a, b} = JSON.parse(data);
    return send(response, 200, {total: a + b});
  }
  send(response, 404, {erro: 'operacao-ausente'});
}
