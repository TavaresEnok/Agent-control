import {join} from 'node:path';

export function arquivoPedido(req) {
  return join('/var/dados', req.query.caminho);
}
